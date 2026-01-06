import {
  createNodeId,
  decodeMessage,
  encodePing,
  encodePong,
  encodeFindNode,
  encodeFindNodeResponse,
  decodeFindNode,
  decodeFindNodeResponse,
  generateMessageId,
  compareDistance,
  xorDistance,
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
    this.pendingRequests = new Map();
    this.ALPHA = 3;
    this.K = 20;
    this.MAX_DIALS = 4;
    this.inflightDials = new Set();

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
        const { messageId, targetNodeId } = decodeFindNode(buf);
        const closest = this.routingTable.findClosest(targetNodeId, 3);

        this.conn.send(peerIdHex, encodeFindNodeResponse(messageId, closest));
        break;
      }

      case MSG_FIND_NODE_RESPONSE: {
        const { messageId, nodes } = decodeFindNodeResponse(buf);
        const key = messageId.toString('hex');

        const clean = [];

        for (const node of nodes) {
          if (
            !Buffer.isBuffer(node) ||
            node.length !== this.peerId.length ||
            node.equals(this.peerId)
          ) {
            continue;
          }

          clean.push(node);
          this.maybeAddNode(node);
        }

        const cb = this.pendingRequests.get(key);
        if (cb) {
          this.pendingRequests.delete(key);
          cb(clean);
        }
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

  async iterativeFindNode(targetNodeId) {
    let shortlist = this.routingTable.findClosest(targetNodeId, this.K);
    const queried = new Set();
    let closestDistance = null;

    while (true) {
      const connected = new Set(this.conn.getConnectedPeers());

      const candidates = [];

      for (const node of shortlist) {
        const hex = node.toString('hex');
        if (queried.has(hex)) continue;

        if (connected.has(hex)) {
          candidates.push(node);
        } else {
          this.maybeDialPeer(hex);
        }

        if (candidates.length >= this.ALPHA) break;
      }

      if (candidates.length === 0) break;

      const responses = await Promise.all(
        candidates.map((nodeId) => {
          const peerIdHex = nodeId.toString('hex');

          if (!this.conn.getConnectedPeers().includes(peerIdHex)) {
            return Promise.resolve([]);
          }

          queried.add(peerIdHex);
          return this.sendFindNode(peerIdHex, targetNodeId);
        })
      );

      let changed = false;

      for (const nodes of responses) {
        for (const node of nodes) {
          if (node.equals(this.peerId)) continue;

          const hex = node.toString('hex');
          if (!shortlist.some((n) => n.equals(node))) {
            shortlist.push(node);
            changed = true;
          }
        }
      }

      shortlist.sort((a, b) =>
        compareDistance(
          xorDistance(a, targetNodeId),
          xorDistance(b, targetNodeId)
        )
      );

      shortlist = shortlist.slice(0, this.K);

      if (0 === shortlist.length) break;

      const newClosest = xorDistance(shortlist[0], targetNodeId).toString(
        'hex'
      );
      if (newClosest === closestDistance && !changed) break;

      closestDistance = newClosest;
    }

    return shortlist;
  }

  sendFindNode(peerIdHex, targetNodeId, timeout = 5000) {
    return new Promise((resolve) => {
      const messageId = generateMessageId();
      const key = messageId.toString('hex');

      const timer = setTimeout(() => {
        this.pendingRequests.delete(key);
        resolve([]);
      }, timeout);

      this.pendingRequests.set(key, (nodes) => {
        clearTimeout(timer);
        resolve(nodes);
      });

      this.conn.send(peerIdHex, encodeFindNode(messageId, targetNodeId));
    });
  }

  maybeDialPeer(peerIdHex) {
    if (this.conn.getConnectedPeers().includes(peerIdHex)) return;
    if (this.inflightDials.has(peerIdHex)) return;
    if (this.inflightDials.size >= this.MAX_DIALS) return;

    this.inflightDials.add(peerIdHex);

    this.connect(peerIdHex)
      .catch(() => {}) // ignore failures for now.
      .finally(() => {
        this.inflightDials.delete(peerIdHex);
      });
  }

  async connect(targetPeerIdHex) {
    if (this.nodeIdHex > targetPeerIdHex) {
      return;
    }
    await this.conn.connect(targetPeerIdHex);
    console.log('Sent offer to', targetPeerIdHex);
  }
}
