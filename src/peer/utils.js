import crypto from 'crypto';

import { MSG_PING, MSG_PONG, NODE_ID_LEN } from './constants.js';

export function createNodeId() {
  return crypto.createHash('sha256').update(crypto.randomBytes(32)).digest();
}

export function encodePing(nodeId) {
  return Buffer.concat([Buffer.from([MSG_PING]), Buffer.from(nodeId)]);
}

export function encodePong(nodeId) {
  return Buffer.concat([Buffer.from([MSG_PONG]), Buffer.from(nodeId)]);
}

export function decodeMessage(buf) {
  if (buf.length < 1 + NODE_ID_LEN) {
    throw new Error('Malformed message');
  }

  return {
    type: buf[0],
    nodeId: buf.subarray(1, 1 + NODE_ID_LEN),
  };
}
