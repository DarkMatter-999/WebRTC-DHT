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
  encodeFindValueResponse,
  decodeFindValueResponse,
  generateKeyId,
  encodeStore,
  decodeStore,
  encodeFindValue,
  decodeFindValue,
  encodeStoreAck,
  decodeStoreAck,
} from './utils.js';

import {
  NODE_ID_LEN,
  MSG_PING,
  MSG_PONG,
  MSG_FIND_NODE,
  MSG_FIND_NODE_RESPONSE,
  MSG_FIND_VALUE_RESPONSE,
  MSG_STORE,
  MSG_STORE_ACK,
  MSG_FIND_VALUE,
} from './constants.js';

import { ConnectionManager } from './connection-manager.js';
import { RoutingTable } from './routing-table.js';

const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL = 1 * 60 * 1000; // 1 minutes
const STORE_TTL = 60 * 60 * 1000; // 1 hour
const REPUBLISH_INTERVAL = 60 * 60 * 1000; // 1 hour
const REPAIR_INTERVAL = 1 * 1000; // 10 minutes
const CACHE_TTL = STORE_TTL / 4;

export class PeerNode {
  constructor({ signalingUrl }) {
    this.signalingUrl = signalingUrl;

    this.peerId = createNodeId();
    this.peerIdHex = this.peerId.toString('hex');

    this.onFindNodeResponse = null;
    this.onPeerConnected = null;

    this.store = new Map();

    this.pendingPings = new Map();
    this.pendingRequests = new Map();
    this.seenRequests = new Map();
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

  async start() {
    console.log('Connecting to signalling server at', this.signalingUrl);
    this.conn.start();

    this._bucketRefreshTimer = setInterval(() => {
      const now = Date.now();

      this.routingTable.buckets.forEach((bucket) => {
        if (now - bucket.lastUsed > REFRESH_INTERVAL) {
          const target = Buffer.from(this.peerId);
          const bit = Math.floor(Math.random() * target.length * 8);
          target[Math.floor(bit / 8)] ^= 1 << (7 - (bit % 8));
          this.iterativeFindNode(target);
        }
      });
    }, REFRESH_INTERVAL);

    setInterval(() => {
      const now = Date.now();
      for (const [k, ts] of this.seenRequests) {
        if (now - ts > CLEANUP_INTERVAL) this.seenRequests.delete(k);
      }
    }, CLEANUP_INTERVAL);

    this._republishTimer = setInterval(() => {
      const now = Date.now();

      for (const [keyHex, entry] of this.store) {
        if (!entry.publisher) continue;

        if (entry.expires - now < STORE_TTL / 2) {
          const keyId = Buffer.from(keyHex, 'hex');
          this.storeValue(keyId, entry.value).catch(() => {});
        }
      }
    }, REPUBLISH_INTERVAL);

    this._repairTimer = setInterval(() => {
      this._repairReplicas().catch(() => {});
    }, REPAIR_INTERVAL);
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
      this.routingTable.promoteReplacement(bucketIndex);
      this.routingTable.addOrUpdateNode(nodeId);
      return;
    }

    this.pingWithTimeout(lruHex).then((alive) => {
      if (!alive) {
        this.routingTable.evict(bucketIndex);
        this.routingTable.promoteReplacement(bucketIndex);
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
        const key = peerIdHex + ':' + messageId.toString('hex');

        if (this.seenRequests.has(key)) return;
        this.seenRequests.set(key, Date.now());

        const closest = this.routingTable.findClosest(targetNodeId, this.K);

        this.conn.send(peerIdHex, encodeFindNodeResponse(messageId, closest));
        break;
      }

      case MSG_FIND_NODE_RESPONSE: {
        const { messageId, nodes } = decodeFindNodeResponse(buf);
        const key = messageId.toString('hex');

        const cb = this.pendingRequests.get(key);
        if (!cb) return;

        const clean = [];

        for (const node of nodes.slice(0, this.K)) {
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

        this.pendingRequests.delete(key);
        cb(clean);
        break;
      }

      case MSG_STORE: {
        const { messageId, key, value } = decodeStore(buf);
        const keyHex = key.toString('hex');

        const now = Date.now();

        const existing = this.store.get(keyHex);
        if (existing && existing.expires > now) return;

        const isPrimary = this._isPrimaryReplica(key);

        this.store.set(keyHex, {
          value,
          expires: Date.now() + STORE_TTL,
          publisher: false,
          isPrimary,
          lastRepair: 0,
        });

        this.conn.send(peerIdHex, encodeStoreAck(messageId));
        this.maybeAddNode(Buffer.from(peerIdHex, 'hex'));
        break;
      }

      case MSG_STORE_ACK: {
        const { messageId } = decodeStoreAck(buf);
        const key = messageId.toString('hex');

        this.maybeAddNode(Buffer.from(peerIdHex, 'hex'));

        const cb = this.pendingRequests.get(key);
        if (!cb) return;

        this.pendingRequests.delete(key);
        cb(true);
        break;
      }

      case MSG_FIND_VALUE: {
        const { messageId, key } = decodeFindValue(buf);
        const keyHex = key.toString('hex');

        const entry = this.store.get(keyHex);
        if (entry && entry.expires > Date.now()) {
          this.conn.send(
            peerIdHex,
            encodeFindValueResponse(messageId, entry.value)
          );
          break;
        }

        const closest = this.routingTable.findClosest(key, this.K);
        this.conn.send(
          peerIdHex,
          encodeFindValueResponse(messageId, null, closest)
        );
        break;
      }

      case MSG_FIND_VALUE_RESPONSE: {
        const { messageId, value, nodes } = decodeFindValueResponse(buf);
        const key = messageId.toString('hex');

        const cb = this.pendingRequests.get(key);
        if (!cb) return;

        this.pendingRequests.delete(key);
        cb({ value, nodes });
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

      const unqueried = shortlist.filter(
        (n) => !queried.has(n.toString('hex'))
      );

      if (unqueried.length === 0) break;

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
        this.routingTable.removeNode(Buffer.from(peerIdHex, 'hex'));
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

  async storeValue(key, value) {
    const keyId = generateKeyId(key);
    const keyHex = keyId.toString('hex');
    const closest = await this.iterativeFindNode(keyId);

    let success = 0;

    for (const node of closest.slice(0, this.K)) {
      const hex = node.toString('hex');
      if (!this.conn.getConnectedPeers().includes(hex)) continue;

      const msgId = generateMessageId();
      const reqKey = msgId.toString('hex');

      success += await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(reqKey);
          resolve(0);
        }, 5000);

        this.pendingRequests.set(reqKey, () => {
          clearTimeout(timer);
          resolve(1);
        });

        this.conn.send(hex, encodeStore(msgId, keyId, value));
      });
    }

    if (this._isPrimaryReplica(keyId)) {
      this.store.set(keyHex, {
        value,
        expires: Date.now() + STORE_TTL,
        publisher: true,
        isPrimary: true,
        lastRepair: 0,
      });
    }

    return success;
  }

  async findValue(key) {
    const keyId = generateKeyId(key);
    const keyHex = keyId.toString('hex');

    const local = this.store.get(keyHex);
    if (local && local.expires > Date.now()) {
      return local.value;
    }

    let shortlist = this.routingTable.findClosest(keyId, this.K);
    const queried = new Set();

    let closestNode = shortlist[0] ?? null;
    let closestQueried = null;

    while (true) {
      const batch = shortlist
        .filter((n) => !queried.has(n.toString('hex')))
        .slice(0, this.ALPHA);

      if (0 === batch.length) break;

      const connected = new Set(this.conn.getConnectedPeers());

      const queries = [];

      for (const node of batch) {
        const hex = node.toString('hex');

        if (!connected.has(hex)) {
          this.maybeDialPeer(hex);
          continue;
        }

        queried.add(hex);

        if (
          !closestQueried ||
          compareDistance(
            xorDistance(node, keyId),
            xorDistance(closestQueried, keyId)
          ) < 0
        ) {
          closestQueried = node;
        }

        queries.push(
          new Promise((resolve) => {
            const msgId = generateMessageId();
            const reqKey = msgId.toString('hex');

            const timer = setTimeout(() => {
              this.pendingRequests.delete(reqKey);
              resolve({ responder: node, res: null });
            }, 5000);

            this.pendingRequests.set(reqKey, (res) => {
              clearTimeout(timer);
              resolve({ responder: node, res });
            });

            this.conn.send(hex, encodeFindValue(msgId, keyId));
          })
        );
      }

      if (queries.length === 0) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const responses = await Promise.all(queries);

      for (const { responder, res } of responses) {
        if (!res) continue;

        this.maybeAddNode(responder);

        if (res.value) {
          this.store.set(keyHex, {
            value: res.value,
            expires: Date.now() + CACHE_TTL,
            publisher: false,
            isPrimary: false,
            lastRepair: 0,
          });

          const cacheTarget =
            closestQueried && !closestQueried.equals(responder)
              ? closestQueried
              : closestNode && !closestNode.equals(responder)
                ? closestNode
                : null;

          if (
            cacheTarget &&
            this.conn.getConnectedPeers().includes(cacheTarget.toString('hex'))
          ) {
            const msgId = generateMessageId();
            this.conn.send(
              cacheTarget.toString('hex'),
              encodeStore(msgId, keyId, res.value)
            );
          }

          return res.value;
        }

        if (res.nodes) {
          for (const n of res.nodes) {
            if (!shortlist.some((x) => x.equals(n))) {
              shortlist.push(n);

              if (
                !closestNode ||
                compareDistance(
                  xorDistance(n, keyId),
                  xorDistance(closestNode, keyId)
                ) < 0
              ) {
                closestNode = n;
              }
            }
          }
        }
      }

      shortlist.sort((a, b) =>
        compareDistance(xorDistance(a, keyId), xorDistance(b, keyId))
      );

      shortlist = shortlist.slice(0, this.K);
    }

    return null;
  }

  async _repairReplicas() {
    const now = Date.now();

    for (const [keyHex, entry] of this.store) {
      if (entry.expires <= now) {
        this.store.delete(keyHex);
        continue;
      }

      const keyId = Buffer.from(keyHex, 'hex');

      if (!entry.isPrimary) continue;

      const closest = await this.iterativeFindNode(keyId);

      let targets = closest
        .slice(0, this.K)
        .map((n) => n.toString('hex'))
        .filter((h) => this.conn.getConnectedPeers().includes(h))
        .filter((h) => h !== this.peerIdHex);

      if (targets.length >= this.K) continue;

      for (const hex of targets) {
        const msgId = generateMessageId();
        this.conn.send(hex, encodeStore(msgId, keyId, entry.value));
      }
    }
  }

  _isPrimaryReplica(keyId) {
    const closest = this.routingTable.findClosest(keyId, this.K);
    return closest.some((n) => n.equals(this.peerId));
  }
}
