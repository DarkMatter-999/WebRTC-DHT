import { xorDistance, compareDistance } from './utils.js';

export class RoutingTable {
  constructor({ nodeId, k = 20 }) {
    this.nodeId = nodeId;
    this.k = k;
    this.buckets = Array.from(
      { length: nodeId.length * 8 }, // 256 buckets for SHA-256
      () => []
    );
  }

  addNode(nodeId) {
    if (nodeId.equals(this.nodeId)) return;

    const bucketIndex = this._bucketIndex(nodeId);
    const bucket = this.buckets[bucketIndex];

    const existingIndex = bucket.findIndex((id) => id.equals(nodeId));

    if (existingIndex !== -1) {
      bucket.splice(existingIndex, 1);
      bucket.push(nodeId);
      return;
    }

    if (bucket.length < this.k) {
      bucket.push(nodeId);
      return;
    }

    // bucket full, ignore for now
  }

  removeNode(nodeId) {
    const bucketIndex = this._bucketIndex(nodeId);
    const bucket = this.buckets[bucketIndex];

    const idx = bucket.findIndex((id) => id.equals(nodeId));
    if (idx !== -1) {
      bucket.splice(idx, 1);
    }
  }

  touch(nodeId) {
    this.addNode(nodeId);
  }

  findClosest(targetId, count = this.k) {
    const allNodes = [];

    for (const bucket of this.buckets) {
      for (const id of bucket) {
        allNodes.push(id);
      }
    }

    allNodes.sort((a, b) =>
      compareDistance(xorDistance(a, targetId), xorDistance(b, targetId))
    );

    return allNodes.slice(0, count);
  }

  size() {
    return this.buckets.reduce((sum, b) => sum + b.length, 0);
  }

  dump() {
    return this.buckets
      .map((bucket, i) => ({
        index: i,
        size: bucket.length,
        nodes: bucket.map((n) => n.toString('hex')),
      }))
      .filter((b) => b.size > 0);
  }

  _bucketIndex(nodeId) {
    const dist = xorDistance(this.nodeId, nodeId);

    for (let i = 0; i < dist.length; i++) {
      if (dist[i] === 0) continue;

      for (let bit = 0; bit < 8; bit++) {
        if (dist[i] & (0x80 >> bit)) {
          return i * 8 + bit;
        }
      }
    }

    // identical IDs (should never happen ig)
    return this.buckets.length - 1;
  }
}
