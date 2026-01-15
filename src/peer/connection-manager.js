import { EventEmitter } from 'events';
import WebSocket from 'ws';
import wrtc from 'wrtc';
import {
  decodeMessage,
  decodeSignal,
  encodePing,
  encodeSignal,
} from './utils.js';
import {
  MSG_SIGNAL_ANSWER,
  MSG_SIGNAL_ICE,
  MSG_SIGNAL_OFFER,
} from './constants.js';

const HEARTBEAT_INTERVAL = 5 * 60 * 1000;
const SEEN_SIGNAL_TTL = 60_000;

/**
 * Manages peer discovery, signaling, and WebRTC data-channel connections.
 *
 * This class abstracts over both direct WebSocket signaling (for bootstrap)
 * and routed, DHT-based signaling once peers are connected. It is responsible
 * for connection lifecycle management, message routing, heartbeats, and
 * connection cleanup.
 */
export class ConnectionManager extends EventEmitter {
  /**
   * Create a new connection manager.
   *
   * @param {object} opts
   * @param {Buffer} opts.nodeId - Local node ID.
   * @param {string} [opts.signalingUrl] - Optional bootstrap signaling server.
   */
  constructor({ nodeId, signalingUrl }) {
    super();

    this.nodeId = nodeId;
    this.nodeIdHex = this.nodeId.toString('hex');

    this.signalingUrl = signalingUrl;
    this.socket = null;

    this.routeSignal = null;

    this.peers = new Map();
    this.knownPeers = new Map();
    this.peerState = new Map();
    this.lastSeen = new Map();

    this.seenSignalIds = new Map();
    this.signalReversePath = new Map();

    this.isBootstrap = false;
    this.signalingClosed = false;
  }

  /**
   * Start the connection manager.
   *
   * Opens the WebSocket signaling connection (if configured), registers
   * with the signaling server, starts peer discovery, and begins periodic
   * heartbeat and garbage-collection tasks.
   */
  start() {
    if (!this.signalingUrl) return;

    this.socket = new WebSocket(this.signalingUrl);

    this.socket.on('open', () => {
      this.socket.send(
        JSON.stringify({
          type: 'register',
          peerId: this.nodeIdHex,
        })
      );
      this.socket.send(JSON.stringify({ type: 'get-peers' }));
    });

    this.socket.on('message', (data) => {
      this._handleSignal(JSON.parse(data));
    });

    this.heartbeatInterval = setInterval(
      () => this._heartbeat(),
      HEARTBEAT_INTERVAL
    );

    this._signalGc = setInterval(() => {
      const now = Date.now();
      for (const [k, ts] of this.seenSignalIds) {
        if (now - ts > SEEN_SIGNAL_TTL) this.seenSignalIds.delete(k);
      }
    }, SEEN_SIGNAL_TTL);
  }

  /**
   * Initiate an outbound WebRTC connection to a peer.
   *
   * Creates a peer connection, opens a data channel, generates an SDP offer,
   * and sends it to the remote peer using either direct signaling or routed
   * DHT signaling.
   *
   * @param {string} peerIdHex - Remote peer ID (hex-encoded).
   */
  async connect(peerIdHex) {
    if (this.peerState.get(peerIdHex)) return;
    this.peerState.set(peerIdHex, 'dialing');

    const pc = this._createPeerConnection(peerIdHex);
    const channel = pc.createDataChannel('dht');

    this._setupChannel(channel, peerIdHex);
    this.peers.set(peerIdHex, { pc, channel, pendingIce: [] });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this._sendSignal(peerIdHex, MSG_SIGNAL_OFFER, offer);
  }

  /**
   * Send a binary message to a connected peer.
   *
   * The message is sent only if the peer's data channel is currently open.
   *
   * @param {string} peerIdHex
   * @param {Buffer} buffer
   */
  send(peerIdHex, buffer) {
    const peer = this.peers.get(peerIdHex);
    if ('open' === peer?.channel?.readyState) {
      peer.channel.send(buffer);
    }
  }

  /**
   * Create (or reuse) a WebRTC peer connection for a peer.
   *
   * This sets up ICE handling, connection state transitions, and data-channel
   * negotiation callbacks.
   *
   * @private
   * @param {string} peerIdHex
   * @returns {RTCPeerConnection}
   */
  _createPeerConnection(peerIdHex) {
    if (this.peers.has(peerIdHex)) {
      return this.peers.get(peerIdHex).pc;
    }

    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (!this.peers.has(peerIdHex)) return;
      this._sendSignal(peerIdHex, MSG_SIGNAL_ICE, e.candidate);
    };

    pc.onconnectionstatechange = () => {
      if ('connected' === pc.connectionState) {
        this.peerState.set(peerIdHex, 'connected');
        this.emit('peerConnected', peerIdHex);
        this._maybeCloseSignaling();
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.peerState.delete(peerIdHex);
        this._dropPeer(peerIdHex);
      }
    };

    pc.ondatachannel = (e) => {
      this._setupChannel(e.channel, peerIdHex);
    };

    return pc;
  }

  /**
   * Configure a WebRTC data channel for a peer.
   *
   * Handles channel lifecycle events, incoming messages, heartbeat tracking,
   * and dispatches protocol messages to the appropriate handlers.
   *
   * @private
   * @param {RTCDataChannel} channel
   * @param {string} peerIdHex
   */
  _setupChannel(channel, peerIdHex) {
    channel.binaryType = 'arraybuffer';

    const peer = this.peers.get(peerIdHex);
    if (peer) {
      peer.channel = channel;
    }

    channel.onopen = () => {
      this.knownPeers.set(peerIdHex, { channel });
      channel.send(encodePing(this.nodeId));
    };

    channel.onmessage = (e) => {
      this.lastSeen.set(peerIdHex, Date.now());

      const buf = Buffer.from(e.data);
      const { type } = decodeMessage(buf);

      if (
        MSG_SIGNAL_ANSWER === type ||
        MSG_SIGNAL_OFFER === type ||
        MSG_SIGNAL_ICE === type
      ) {
        this._handleDhtSignal(buf);
        return;
      }

      this.emit('message', peerIdHex, buf);
    };
  }

  /**
   * Handle messages received from the WebSocket signaling server.
   *
   * This includes peer discovery responses and direct offer/answer/ICE
   * messages during the bootstrap phase.
   *
   * @private
   * @param {object} msg
   */
  _handleSignal(msg) {
    if ('peers' === msg.type) {
      if (
        0 === msg.peers.length ||
        parseInt(this.nodeIdHex.slice(0, 8), 16) % 5 === 0
      ) {
        this.isBootstrap = true;
        return;
      }

      msg.peers.slice(0, 3).forEach((pid) => this.connect(pid));
      return;
    }

    if ('offer' === msg.type) this._acceptOffer(msg);
    if ('answer' === msg.type) this._acceptAnswer(msg);
    if ('ice' === msg.type) this._addIceCandidate(msg);
  }

  /**
   * Handle a routed DHT signaling message.
   *
   * Messages are de-duplicated, forwarded if they are not addressed to this
   * node, or applied locally if they target this node.
   *
   * @private
   * @param {Buffer} buf
   */
  async _handleDhtSignal(buf) {
    const { type, payload } = decodeSignal(buf);
    const { messageId } = payload;

    const now = Date.now();
    const ts = this.seenSignalIds.get(messageId);
    if (ts && now - ts < SEEN_SIGNAL_TTL) return;
    this.seenSignalIds.set(messageId, now);

    if (payload.to !== this.nodeIdHex) {
      if (!this.routeSignal) return;

      const nextHops = this.routeSignal(payload.to);

      for (const hex of nextHops) {
        const peer = this.peers.get(hex);
        if (peer?.channel?.readyState === 'open') {
          peer.channel.send(encodeSignal(type, payload));
        }
      }
      return;
    }

    setTimeout(() => {
      this.seenSignalIds.delete(messageId);
    }, SEEN_SIGNAL_TTL);

    switch (type) {
      case MSG_SIGNAL_OFFER:
        await this._acceptOffer({
          from: payload.from,
          sdp: payload.payload,
        });
        break;

      case MSG_SIGNAL_ANSWER:
        await this._acceptAnswer({
          from: payload.from,
          sdp: payload.payload,
        });
        break;

      case MSG_SIGNAL_ICE:
        await this._addIceCandidate({
          from: payload.from,
          candidate: payload.payload,
        });
        break;
    }
  }

  /**
   * Accept and respond to an incoming SDP offer.
   *
   * Performs glare resolution, sets the remote description, applies any
   * queued ICE candidates, and sends an SDP answer.
   *
   * @private
   * @param {{from: string, sdp: any}} param0
   */
  async _acceptOffer({ from, sdp }) {
    if (this.peers.has(from)) return;

    if (this.peerState.get(from) === 'dialing') {
      if (this.nodeIdHex > from) {
        return;
      }
    }
    this.peerState.set(from, 'dialing');

    const pc = this._createPeerConnection(from);
    this.peers.set(from, {
      pc,
      channel: null,
      pendingIce: [],
    });

    await pc.setRemoteDescription(sdp);

    const peer = this.peers.get(from);
    for (const c of peer.pendingIce) {
      try {
        await pc.addIceCandidate(c);
      } catch {}
    }
    peer.pendingIce.length = 0;

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this._sendSignal(from, MSG_SIGNAL_ANSWER, answer);
  }

  /**
   * Apply an incoming SDP answer to an existing connection.
   *
   * @private
   * @param {{from: string, sdp: any}} param0
   */
  async _acceptAnswer({ from, sdp }) {
    const peer = this.peers.get(from);
    if (!peer) return;

    if (!peer.pc.remoteDescription) {
      await peer.pc.setRemoteDescription(sdp);

      for (const c of peer.pendingIce) {
        try {
          await peer.pc.addIceCandidate(c);
        } catch {}
      }
      peer.pendingIce.length = 0;
    }
  }

  /**
   * Add an ICE candidate to a peer connection.
   *
   * Candidates received before the remote description is set are queued.
   *
   * @private
   * @param {{from: string, candidate: any}} param0
   */
  async _addIceCandidate({ from, candidate }) {
    const peer = this.peers.get(from);
    if (!peer) return;

    if (peer.pc.connectionState === 'closed') return;

    if (!peer.pc.remoteDescription) {
      peer.pendingIce.push(candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      console.error('addIceCandidate failed (ignored)');
      console.error(err);
    }
  }

  /**
   * Send a signaling message to a peer.
   *
   * Uses the WebSocket signaling server if available, otherwise falls back
   * to routed DHT signaling via connected peers.
   *
   * @private
   * @param {string} peerIdHex
   * @param {number} type
   * @param {any} payload
   */
  _sendSignal(peerIdHex, type, payload) {
    if (WebSocket.OPEN === this.socket?.readyState) {
      const wstype =
        type === MSG_SIGNAL_OFFER
          ? 'offer'
          : type === MSG_SIGNAL_ANSWER
            ? 'answer'
            : 'ice';

      this._sendSignalWS(wstype, peerIdHex, payload);
      return;
    }

    if (!this.routeSignal) return;

    const msg = encodeSignal(type, {
      from: this.nodeIdHex,
      to: peerIdHex,
      payload,
    });

    const next = this.routeSignal(peerIdHex);
    for (const hex of next) {
      const peer = this.peers.get(hex);
      if (peer?.channel?.readyState === 'open') {
        peer.channel.send(msg);
      }
    }
  }

  /**
   * Send a signaling message over the WebSocket connection.
   *
   * @private
   * @param {string} type
   * @param {string} to
   * @param {any} payload
   */
  _sendSignalWS(type, to, payload) {
    this.socket.send(
      JSON.stringify({
        type,
        from: this.nodeIdHex,
        to,
        ...('ice' === type ? { candidate: payload } : { sdp: payload }),
      })
    );
  }

  /**
   * Close the WebSocket signaling connection once it is no longer required.
   *
   * @private
   */
  _maybeCloseSignaling() {
    if (this.isBootstrap) return;
    if (this.signalingClosed) return;

    this.signalingClosed = true;
    this.socket.close();
  }

  /**
   * Return IDs of peers with an open data channel.
   *
   * @returns {string[]}
   */
  getConnectedPeers() {
    const out = [];
    for (const [id, p] of this.peers) {
      if (p.channel?.readyState === 'open') {
        out.push(id);
      }
    }
    return out;
  }

  /**
   * Return IDs of all peers that have ever connected.
   *
   * @returns {string[]}
   */
  getKnownPeerIds() {
    return [...this.knownPeers.keys()];
  }

  /**
   * Broadcast a message to all currently connected peers.
   *
   * @param {Buffer} buf
   */
  broadcast(buf) {
    for (const { channel } of this.knownPeers.values()) {
      if ('open' === channel.readyState) {
        channel.send(buf);
      }
    }
  }

  /**
   * Periodic maintenance task.
   *
   * Sends heartbeat pings to peers and drops connections that have been
   * inactive for too long.
   *
   * @private
   */
  _heartbeat() {
    const now = Date.now();

    for (const [peerId, peer] of this.peers) {
      const last = this.lastSeen.get(peerId) ?? 0;

      if (now - last > 2 * HEARTBEAT_INTERVAL) {
        this._dropPeer(peerId);
        continue;
      }

      if ('open' === peer.channel?.readyState) {
        peer.channel.send(encodePing(this.nodeId));
      }
    }
  }

  /**
   * Tear down and forget a peer connection.
   *
   * Closes the data channel and peer connection, removes all internal state,
   * and emits a `peerDisconnected` event.
   *
   * @private
   * @param {string} peerIdHex
   */
  _dropPeer(peerIdHex) {
    const peer = this.peers.get(peerIdHex);
    if (!peer) return;

    try {
      peer.channel?.close();
    } catch {}
    try {
      peer.pc?.close();
    } catch {}

    this.peers.delete(peerIdHex);
    this.knownPeers.delete(peerIdHex);
    this.lastSeen.delete(peerIdHex);
    this.peerState.delete(peerIdHex);

    this.emit('peerDisconnected', peerIdHex);
  }
}
