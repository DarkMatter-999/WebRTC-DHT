import {
  createNodeId,
  decodeMessage,
  encodePing,
  encodePong,
  encodeFindNode,
  encodeFindNodeResponse,
  decodeFindNode,
  decodeFindNodeResponse,
} from './utils.js';

import {
  NODE_ID_LEN,
  MSG_PING,
  MSG_PONG,
  MSG_FIND_NODE,
  MSG_FIND_NODE_RESPONSE,
} from './constants.js';

import { ConnectionManager } from './connection-manager.js';
import { RoutingTable } from './routing-table.js';

export class PeerNode {
  constructor({ signalingUrl }) {
    this.signalingUrl = signalingUrl;

    this.peerId = createNodeId();
    this.peerIdHex = this.peerId.toString('hex');

    this.onFindNodeResponse = null;
    this.onPeerConnected = null;

    this.pendingPings = new Map();

    this.conn = new ConnectionManager({
      nodeId: this.peerId,
      signalingUrl,
    });

    this.routingTable = new RoutingTable({
      nodeId: this.peerId,
      k: 20,
    });

    this.conn.on('message', (peerIdHex, buf) =>
      this.handleMessage(peerIdHex, buf)
    );

    this.conn.on('peerConnected', (peerIdHex) => {
      const nodeId = Buffer.from(peerIdHex, 'hex');
      this.maybeAddNode(nodeId);
      this.onPeerConnected?.(peerIdHex);
    });

    this.conn.on('peerDisconnected', (peerIdHex) => {
      this.routingTable.removeNode(Buffer.from(peerIdHex, 'hex'));
    });
  }

  start() {
    console.log('Connecting to signalling server at', this.signalingUrl);
    this.conn.start();
  }

  maybeAddNode(nodeId) {
    const result = this.routingTable.addOrUpdateNode(nodeId);
    if (!result || result.action !== 'full') return;

    const bucketIndex = result.bucketIndex;
    const lru = this.routingTable.getLeastRecentlySeen(bucketIndex);
    if (!lru) return;

    const lruHex = lru.toString('hex');

    if (!this.conn.getConnectedPeers().includes(lruHex)) {
      this.routingTable.evict(bucketIndex);
      this.routingTable.addOrUpdateNode(nodeId);
      return;
    }

    this.pingWithTimeout(lruHex).then((alive) => {
      if (!alive) {
        this.routingTable.evict(bucketIndex);
        this.routingTable.addOrUpdateNode(nodeId);
      }
    });
  }

  handleMessage(peerIdHex, buf) {
    const { type, content } = decodeMessage(buf);

    switch (type) {
      case MSG_PING: {
        const nodeId = content.subarray(0, NODE_ID_LEN);
        const nodeIdHex = nodeId.toString('hex');

        if (nodeIdHex !== peerIdHex) {
          console.warn('NodeId mismatch, dropping peer', peerIdHex);
          this.conn._dropPeer(peerIdHex);
          return;
        }

        this.maybeAddNode(nodeId);
        this.conn.send(peerIdHex, encodePong(this.peerId));
        break;
      }

      case MSG_PONG: {
        const nodeId = content.subarray(0, NODE_ID_LEN);
        const nodeIdHex = nodeId.toString('hex');

        if (nodeIdHex !== peerIdHex) {
          console.warn('NodeId mismatch, dropping peer', peerIdHex);
          this.conn._dropPeer(peerIdHex);
          return;
        }

        this.maybeAddNode(nodeId);

        const cb = this.pendingPings.get(peerIdHex);
        if (cb) {
          this.pendingPings.delete(peerIdHex);
          cb();
        }
        break;
      }

      case MSG_FIND_NODE: {
        const targetNodeId = decodeFindNode(buf);
        const closest = this.routingTable.findClosest(targetNodeId, 3);
        this.conn.send(peerIdHex, encodeFindNodeResponse(closest));
        break;
      }

      case MSG_FIND_NODE_RESPONSE: {
        const nodes = decodeFindNodeResponse(buf);

        const clean = nodes.filter(
          (n) =>
            Buffer.isBuffer(n) &&
            n.length === this.peerId.length &&
            !n.equals(this.peerId)
        );

        for (const nodeId of clean) {
          this.maybeAddNode(nodeId);
        }

        this.onFindNodeResponse?.(clean);
        break;
      }

      default:
        console.warn('Unknown message type:', type);
    }
  }

  ping(peerIdHex) {
    this.conn.send(peerIdHex, encodePing(this.peerId));
  }

  pingWithTimeout(peerIdHex, timeout = 3000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(peerIdHex);
        resolve(false);
      }, timeout);

      this.pendingPings.set(peerIdHex, () => {
        clearTimeout(timer);
        resolve(true);
      });

      this.ping(peerIdHex);
    });
  }

  findNode(targetNodeId) {
    for (const peerIdHex of this.conn.getConnectedPeers()) {
      this.conn.send(peerIdHex, encodeFindNode(targetNodeId));
    }
  }

  async connect(targetPeerIdHex) {
    if (this.nodeIdHex > targetPeerIdHex) {
      return;
    }
    await this.conn.connect(targetPeerIdHex);
    console.log('Sent offer to', targetPeerIdHex);
  }
}
