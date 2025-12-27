import crypto from 'crypto';

import {
  MSG_FIND_NODE,
  MSG_FIND_NODE_RESPONSE,
  MSG_PING,
  MSG_PONG,
  NODE_ID_LEN,
} from './constants.js';

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
  if (buf.length < 1) throw new Error('Malformed message');

  return {
    type: buf[0],
    content: buf.subarray(1),
  };
}

export function xorDistance(a, b) {
  const buf = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    buf[i] = a[i] ^ b[i];
  }
  return buf;
}

export function compareDistance(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function encodeFindNode(targetNodeId) {
  const buf = Buffer.alloc(1 + targetNodeId.length);
  buf[0] = MSG_FIND_NODE;
  targetNodeId.copy(buf, 1);
  return buf;
}

export function encodeFindNodeResponse(nodeIds) {
  const buf = Buffer.alloc(1 + 1 + nodeIds.length * nodeIds[0].length);
  buf[0] = MSG_FIND_NODE_RESPONSE;
  buf[1] = nodeIds.length;
  nodeIds.forEach((id, idx) => id.copy(buf, 2 + idx * id.length));
  return buf;
}

export function decodeFindNode(buf) {
  const targetNodeId = buf.subarray(1, 1 + NODE_ID_LEN);
  return targetNodeId;
}

export function decodeFindNodeResponse(buf) {
  const count = buf[1];
  const nodeIds = [];
  for (let i = 0; i < count; i++) {
    nodeIds.push(buf.subarray(2 + i * NODE_ID_LEN, 2 + (i + 1) * NODE_ID_LEN));
  }
  return nodeIds;
}

export function encodeSignal(type, payload) {
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf = Buffer.alloc(1 + payloadBuf.length);
  buf[0] = type;
  payloadBuf.copy(buf, 1);
  return buf;
}

export function decodeSignal(buf) {
  const type = buf[0];
  const payload = JSON.parse(buf.subarray(1).toString());
  return { type, payload };
}
