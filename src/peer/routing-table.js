import { xorDistance, compareDistance } from './utils.js';

export class RoutingTable {
  constructor({ nodeId, k = 20 }) {
    this.nodeId = nodeId;
    this.k = k;
    this.buckets = Array.from(
      { length: nodeId.length * 8 }, // 256 buckets for SHA-256
      () => ({
        nodes: [],
        replacements: [],
        lastUsed: Date.now(),
      })
    );
  }

  addOrUpdateNode(nodeId) {
    if (!Buffer.isBuffer(nodeId)) return;
    if (nodeId.length !== this.nodeId.length) return;
    if (nodeId.equals(this.nodeId)) return;

    const i = this._bucketIndex(nodeId);

    const bucket = this.buckets[i];
    bucket.lastUsed = Date.now();

    const idx = bucket.nodes.findIndex((id) => id.equals(nodeId));
    if (idx !== -1) {
      bucket.nodes.splice(idx, 1);
      bucket.nodes.push(nodeId);
      return { action: 'updated' };
    }

    if (bucket.nodes.length < this.k) {
      bucket.nodes.push(nodeId);
      return { action: 'added' };
    }

    if (!bucket.replacements.some((id) => id.equals(nodeId))) {
      bucket.replacements.push(nodeId);
      if (bucket.replacements.length > this.k) {
        bucket.replacements.shift();
      }
    }

    return { action: 'full', bucketIndex: i };
  }

  removeNode(nodeId) {
    const bucketIndex = this._bucketIndex(nodeId);
    const bucket = this.buckets[bucketIndex];

    const idx = bucket.nodes.findIndex((id) => id.equals(nodeId));
    if (idx !== -1) {
      bucket.nodes.splice(idx, 1);
    }
  }

  touch(nodeId) {
    return this.addOrUpdateNode(nodeId);
  }

  getLeastRecentlySeen(bucketIndex) {
    return this.buckets[bucketIndex].nodes[0];
  }

  evict(bucketIndex) {
    this.buckets[bucketIndex].nodes.shift();
  }

  findClosest(targetId, count = this.k) {
    const results = [];
    const start = this._bucketIndex(targetId);

    for (let d = 0; d < this.buckets.length && results.length < count; d++) {
      const i = d % 2 === 0 ? start + d : start - d;
      if (i < 0 || i >= this.buckets.length) continue;

      const bucket = this.buckets[i];
      for (const id of bucket.nodes) {
        results.push(id);
        if (results.length >= count) break;
      }

      if (bucket.nodes.length > 0) {
        bucket.lastUsed = Date.now();
      }
    }

    results.sort((a, b) =>
      compareDistance(xorDistance(a, targetId), xorDistance(b, targetId))
    );

    return results.slice(0, count);
  }

  size() {
    return this.buckets.reduce((sum, b) => sum + b.nodes.length, 0);
  }

  dump() {
    return this.buckets
      .map((bucket, i) => ({
        index: i,
        size: bucket.nodes.length,
        nodes: bucket.nodes.map((n) => n.toString('hex')),
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

  promoteReplacement(bucketIndex) {
    const bucket = this.buckets[bucketIndex];
    const replacement = bucket.replacements.shift();
    if (replacement) {
      bucket.nodes.push(replacement);
    }
  }
}
