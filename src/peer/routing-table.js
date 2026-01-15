import { xorDistance, compareDistance } from './utils.js';

/**
 * Kademlia-style routing table.
 * Buckets are indexed by first differing bit.
 */
export class RoutingTable {
  /**
   * @param {object} opts
   * @param {Buffer} opts.nodeId
   * @param {number} [opts.k=20]
   */
  constructor({ nodeId, k = 20 }) {
    this.nodeId = nodeId;
    this.k = k;

    /**
     * Buckets indexed by distance bit.
     */
    this.buckets = Array.from(
      { length: nodeId.length * 8 }, // 256 buckets for SHA-256
      () => ({
        nodes: [],
        replacements: [],
        lastUsed: Date.now(),
      })
    );
  }

  /**
   * Add or update a node in the routing table.
   *
   * @param {Buffer} nodeId
   * @returns {{action: string, bucketIndex?: number}|undefined}
   */
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

  /**
   * Remove a node from the routing table.
   *
   * @param {Buffer} nodeId
   */
  removeNode(nodeId) {
    const bucketIndex = this._bucketIndex(nodeId);
    const bucket = this.buckets[bucketIndex];

    const idx = bucket.nodes.findIndex((id) => id.equals(nodeId));
    if (idx !== -1) {
      bucket.nodes.splice(idx, 1);
    }
  }

  /**
   * Update a node's recency.
   *
   * @param {Buffer} nodeId
   * @returns {{action: string, bucketIndex?: number}|undefined}
   */
  touch(nodeId) {
    return this.addOrUpdateNode(nodeId);
  }

  /**
   * Get least recently seen node in a bucket.
   *
   * @param {number} bucketIndex
   * @returns {Buffer|undefined}
   */
  getLeastRecentlySeen(bucketIndex) {
    return this.buckets[bucketIndex].nodes[0];
  }

  /**
   * Evict least recently seen node from a bucket.
   *
   * @param {number} bucketIndex
   */
  evict(bucketIndex) {
    this.buckets[bucketIndex].nodes.shift();
  }

  /**
   * Find closest nodes to a target ID.
   *
   * @param {Buffer} targetId
   * @param {number} count
   * @returns {Buffer[]}
   */
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

  /**
   * Total number of nodes in the table.
   *
   * @returns {number}
   */
  size() {
    return this.buckets.reduce((sum, b) => sum + b.nodes.length, 0);
  }

  /**
   * Dump routing table contents for debugging.
   *
   * @returns {{index: number, size: number, nodes: string[]}[]}
   */
  dump() {
    return this.buckets
      .map((bucket, i) => ({
        index: i,
        size: bucket.nodes.length,
        nodes: bucket.nodes.map((n) => n.toString('hex')),
      }))
      .filter((b) => b.size > 0);
  }

  /**
   * Compute bucket index based on first differing bit.
   *
   * @private
   * @param {Buffer} nodeId
   * @returns {number}
   */
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

  /**
   * Promote a replacement node into the main bucket.
   *
   * @param {number} bucketIndex
   */
  promoteReplacement(bucketIndex) {
    const bucket = this.buckets[bucketIndex];
    const replacement = bucket.replacements.shift();
    if (replacement) {
      bucket.nodes.push(replacement);
    }
  }
}
