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

const HEARTBEAT_INTERVAL = 60_000;
const SEEN_SIGNAL_TTL = 60_000;

export class ConnectionManager extends EventEmitter {
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

  send(peerIdHex, buffer) {
    const peer = this.peers.get(peerIdHex);
    if ('open' === peer?.channel?.readyState) {
      peer.channel.send(buffer);
    }
  }

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

  _maybeCloseSignaling() {
    if (this.isBootstrap) return;
    if (this.signalingClosed) return;

    this.signalingClosed = true;
    this.socket.close();
  }

  getConnectedPeers() {
    const out = [];
    for (const [id, p] of this.peers) {
      if (p.channel?.readyState === 'open') {
        out.push(id);
      }
    }
    return out;
  }

  getKnownPeerIds() {
    return [...this.knownPeers.keys()];
  }

  broadcast(buf) {
    for (const { channel } of this.knownPeers.values()) {
      if ('open' === channel.readyState) {
        channel.send(buf);
      }
    }
  }

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
