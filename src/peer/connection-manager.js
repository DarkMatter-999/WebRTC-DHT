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

export class ConnectionManager extends EventEmitter {
  constructor({ nodeId, signalingUrl }) {
    super();

    this.nodeId = nodeId;
    this.nodeIdHex = this.nodeId.toString('hex');

    this.signalingUrl = signalingUrl;
    this.socket = null;

    this.peers = new Map();
    this.knownPeers = new Map();
    this.lastSeen = new Map();

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
  }

  async connect(peerIdHex) {
    if (this.peers.has(peerIdHex)) return;

    const pc = this._createPeerConnection(peerIdHex);
    const channel = pc.createDataChannel('dht');

    this._setupChannel(channel, peerIdHex);
    this.peers.set(peerIdHex, { pc, channel });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this._sendSignal(peerIdHex, MSG_SIGNAL_OFFER, offer);
  }

  send(peerIdHex, buffer) {
    const peer = this.peers.get(peerIdHex);
    if (peer?.channel?.readyState === 'open') {
      peer.channel.send(buffer);
    }
  }

  _createPeerConnection(peerIdHex) {
    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;

      this._sendSignal(peerIdHex, MSG_SIGNAL_ICE, e.candidate);
    };

    pc.onconnectionstatechange = () => {
      if ('connected' === pc.connectionState) {
        this.emit('peerConnected', peerIdHex);
        this._maybeCloseSignaling();
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
      } else {
        this.emit('message', peerIdHex, buf);
      }
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

    if (payload.to !== this.nodeIdHex) {
      if ((payload.ttl ?? 7) > 0) {
        payload.ttl--;
        this.broadcast(encodeSignal(type, payload));
      }
      return;
    }

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

    const pc = this._createPeerConnection(from);
    this.peers.set(from, { pc, channel: null });

    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this._sendSignal(from, MSG_SIGNAL_ANSWER, answer);
  }

  async _acceptAnswer({ from, sdp }) {
    const peer = this.peers.get(from);
    if (!peer) return;

    if (peer.pc.signalingState !== 'stable') {
      await peer.pc.setRemoteDescription(sdp);
    }
  }

  async _addIceCandidate({ from, candidate }) {
    const peer = this.peers.get(from);
    if (!peer) return;
    await peer.pc.addIceCandidate(candidate);
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
    } else {
      this.broadcast(
        encodeSignal(type, {
          from: this.nodeIdHex,
          to: peerIdHex,
          payload,
          ttl: 7,
        })
      );
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
    return [...this.peers.keys()];
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

      if (peer.channel?.readyState === 'open') {
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

    this.emit('peerDisconnected', peerIdHex);
  }
}
