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

export function generateMessageId() {
  return crypto.randomBytes(8);
}

export function randomNodeId() {
  return crypto.randomBytes(32);
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

export function encodeFindNode(messageId, targetNodeId) {
  if (messageId.length !== 8) {
    throw new Error('messageId must be 8 bytes');
  }

  const buf = Buffer.alloc(1 + 8 + NODE_ID_LEN);
  buf[0] = MSG_FIND_NODE;
  messageId.copy(buf, 1);
  targetNodeId.copy(buf, 9);
  return buf;
}

export function encodeFindNodeResponse(messageId, nodeIds) {
  if (messageId.length !== 8) {
    throw new Error('messageId must be 8 bytes');
  }

  const count = nodeIds.length;
  const buf = Buffer.alloc(1 + 8 + 1 + count * NODE_ID_LEN);

  buf[0] = MSG_FIND_NODE_RESPONSE;
  messageId.copy(buf, 1);
  buf[9] = count;

  nodeIds.forEach((id, i) => {
    id.copy(buf, 10 + i * NODE_ID_LEN);
  });

  return buf;
}

export function decodeFindNode(buf) {
  const messageId = buf.subarray(1, 9);
  const targetNodeId = buf.subarray(9, 9 + NODE_ID_LEN);
  return { messageId, targetNodeId };
}

export function decodeFindNodeResponse(buf) {
  const messageId = buf.subarray(1, 9);
  const count = buf[9];

  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(buf.subarray(10 + i * NODE_ID_LEN, 10 + (i + 1) * NODE_ID_LEN));
  }
  return { messageId, nodes };
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
