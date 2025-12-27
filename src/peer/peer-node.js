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
    this.peers = new Map();
    this.knownPeers = new Map();

    this.isBootstrap = false;
    this.signalingClosed = false;

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

      const peersWithDistance = msg.peers.map((peerIdHex) => {
        const nodeId = Buffer.from(peerIdHex, 'hex');
        const distance = xorDistance(this.peerId, nodeId);
        return { peerIdHex, distance };
      });

      peersWithDistance.sort((a, b) => compareDistance(a.distance, b.distance));

      // Connect to top-k closest peers (k=3)
      const topK = peersWithDistance.slice(0, 3);
      for (const peer of topK) {
        if (!this.peers.has(peer.peerIdHex)) {
          await this.startConnection(peer.peerIdHex);
        }
      }
    }

    if (msg.type === 'offer') {
      if (!this.peers.has(msg.from)) {
        await this.acceptOffer(msg.sdp, msg.from);
      }
    }

    if (msg.type === 'answer') {
      const peer = this.peers.get(msg.from);
      if (peer && peer.pc) {
        await peer.pc.setRemoteDescription(msg.sdp);
      }
    }

    if (msg.type === 'ice') {
      const peer = this.peers.get(msg.from);
      if (peer && peer.pc) {
        await peer.pc.addIceCandidate(msg.candidate);
      }
    }
  }

  createPeerConnection(targetPeerId) {
    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.send(
          JSON.stringify({
            type: 'ice',
            from: this.peerIdHex,
            to: targetPeerId,
            candidate: e.candidate,
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.onPeerConnected?.(targetPeerId);

        if (!this.signalingClosed && !this.isBootstrap) {
          this.signalingClosed = true;
          this.socket.close();
        }
      }
    };

    return pc;
  }

  async startConnection(targetPeerId) {
    const pc = this.createPeerConnection(targetPeerId);
    const channel = pc.createDataChannel('dht');
    this.setupChannel(channel, targetPeerId);

    this.peers.set(targetPeerId, { pc, channel });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.socket.send(
      JSON.stringify({
        type: 'offer',
        from: this.peerIdHex,
        to: targetPeerId,
        sdp: offer,
      })
    );
  }

  async acceptOffer(offer, fromPeerId) {
    const pc = this.createPeerConnection(fromPeerId);

    pc.ondatachannel = (e) => {
      const channel = e.channel;
      this.setupChannel(channel, fromPeerId);
      const peer = this.peers.get(fromPeerId);
      peer.channel = channel;
    };

    await pc.setRemoteDescription(offer);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.peers.set(fromPeerId, { pc, channel: null });

    this.socket.send(
      JSON.stringify({
        type: 'answer',
        from: this.peerIdHex,
        to: fromPeerId,
        sdp: answer,
      })
    );
  }

  setupChannel(channel, peerIdHex) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log('DataChannel open with', peerIdHex);
      channel.send(encodePing(this.peerId));
    };

    channel.onmessage = (e) => this.handleMessage(Buffer.from(e.data), channel);
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
