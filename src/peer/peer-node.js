import WebSocket from 'ws';
import wrtc from 'wrtc';

import {
  createNodeId,
  decodeMessage,
  encodePing,
  encodePong,
  encodeFindNode,
  encodeFindNodeResponse,
  decodeFindNode,
  decodeFindNodeResponse,
  xorDistance,
  compareDistance,
} from './utils.js';

import {
  MSG_PING,
  MSG_PONG,
  MSG_FIND_NODE,
  MSG_FIND_NODE_RESPONSE,
} from './constants.js';

export class PeerNode {
  constructor({ signalingUrl }) {
    this.signalingUrl = signalingUrl;

    this.peerId = createNodeId();
    this.peerIdHex = this.peerId.toString('hex');

    this.socket = null;
    this.pc = null;
    this.channel = null;
    this.targetPeerId = null;

    this.isBootstrap = false;
    this.signalingClosed = false;

    this.knownPeers = new Map();

    this.onFindNodeResponse = null;
    this.onPeerConnected = null;
  }

  start() {
    this.socket = new WebSocket(this.signalingUrl);
    console.log('Connecting to signalling server at', this.signalingUrl);

    this.socket.on('open', () => {
      this.socket.send(
        JSON.stringify({ type: 'register', peerId: this.peerIdHex })
      );
      this.socket.send(JSON.stringify({ type: 'get-peers' }));
    });

    this.socket.on('message', (data) => {
      this.handleSignal(JSON.parse(data));
    });
  }

  async handleSignal(msg) {
    if (msg.type === 'peers') {
      if (msg.peers.length === 0) {
        console.log('No peers found, acting as bootstrap');
        this.isBootstrap = true;
        return;
      }

      if (!this.pc) {
        this.targetPeerId = msg.peers[0];
        await this.startConnection();
      }
    }

    if (msg.type === 'offer') {
      this.targetPeerId = msg.from;
      await this.acceptOffer(msg.sdp);
    }

    if (msg.type === 'answer') {
      await this.pc.setRemoteDescription(msg.sdp);
    }

    if (msg.type === 'ice') {
      await this.pc.addIceCandidate(msg.candidate);
    }
  }

  createPeerConnection() {
    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.send(
          JSON.stringify({
            type: 'ice',
            from: this.peerIdHex,
            to: this.targetPeerId,
            candidate: e.candidate,
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.onPeerConnected?.(this.targetPeerId);

        if (!this.signalingClosed && !this.isBootstrap) {
          this.signalingClosed = true;
          this.socket.close();
        }
      }
    };

    return pc;
  }

  async startConnection() {
    this.pc = this.createPeerConnection();

    this.channel = this.pc.createDataChannel('dht');
    this.setupChannel(this.channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.socket.send(
      JSON.stringify({
        type: 'offer',
        from: this.peerIdHex,
        to: this.targetPeerId,
        sdp: offer,
      })
    );
  }

  async acceptOffer(offer) {
    this.pc = this.createPeerConnection();

    this.pc.ondatachannel = (e) => {
      this.channel = e.channel;
      this.setupChannel(this.channel);
    };

    await this.pc.setRemoteDescription(offer);

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.socket.send(
      JSON.stringify({
        type: 'answer',
        from: this.peerIdHex,
        to: this.targetPeerId,
        sdp: answer,
      })
    );
  }

  setupChannel(ch) {
    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      console.log('DataChannel open');
      ch.send(encodePing(this.peerId));
    };

    ch.onmessage = (e) => this.handleMessage(Buffer.from(e.data), ch);
  }

  handleMessage(buf, ch) {
    const { type, nodeId } = decodeMessage(buf);
    const nodeIdHex = nodeId.toString('hex');

    switch (type) {
      case MSG_PING:
        if (!nodeId.equals(this.peerId)) {
          this.knownPeers.set(nodeIdHex, { nodeId, channel: ch });
          console.log('PING from', nodeIdHex);
          ch.send(encodePong(this.peerId));
        }
        break;

      case MSG_PONG:
        if (!nodeId.equals(this.peerId)) {
          this.knownPeers.set(nodeIdHex, { nodeId, channel: ch });
          console.log('PONG from', nodeIdHex);
        }
        break;

      case MSG_FIND_NODE: {
        const targetNodeId = decodeFindNode(buf);

        const closest = [...this.knownPeers.values()]
          .map((p) => p.nodeId)
          .sort((a, b) =>
            compareDistance(
              xorDistance(a, targetNodeId),
              xorDistance(b, targetNodeId)
            )
          )
          .slice(0, 3);

        ch.send(encodeFindNodeResponse(closest));
        break;
      }

      case MSG_FIND_NODE_RESPONSE: {
        const nodes = decodeFindNodeResponse(buf);
        console.log(
          'FIND_NODE response:',
          nodes.map((id) => id.toString('hex'))
        );
        this.onFindNodeResponse?.(nodes);
        break;
      }
    }
  }

  ping(peerIdHex) {
    const peer = this.knownPeers.get(peerIdHex);
    if (peer) peer.channel.send(encodePing(this.peerId));
  }

  findNode(targetNodeId) {
    for (const peer of this.knownPeers.values()) {
      peer.channel.send(encodeFindNode(targetNodeId));
    }
  }

  getPeers() {
    return [...this.knownPeers.keys()];
  }
}
