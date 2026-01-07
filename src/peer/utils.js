import crypto from 'crypto';

import {
  MSG_FIND_NODE,
  MSG_FIND_NODE_RESPONSE,
  MSG_FIND_VALUE,
  MSG_FIND_VALUE_RESPONSE,
  MSG_PING,
  MSG_PONG,
  MSG_STORE,
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

export function generateKeyId(key) {
  return crypto.createHash('sha256').update(key).digest();
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

export function encodeStore(messageId, key, value) {
  const valueBuf = Buffer.from(value);
  const buf = Buffer.alloc(1 + 8 + NODE_ID_LEN + 4 + valueBuf.length);

  buf[0] = MSG_STORE;
  messageId.copy(buf, 1);
  key.copy(buf, 9);
  buf.writeUInt32BE(valueBuf.length, 9 + NODE_ID_LEN);
  valueBuf.copy(buf, 13 + NODE_ID_LEN);

  return buf;
}

export function decodeStore(buf) {
  const messageId = buf.subarray(1, 9);
  const key = buf.subarray(9, 9 + NODE_ID_LEN);
  const len = buf.readUInt32BE(9 + NODE_ID_LEN);
  const value = buf.subarray(13 + NODE_ID_LEN, 13 + NODE_ID_LEN + len);

  return { messageId, key, value };
}

export function encodeFindValue(messageId, key) {
  const buf = Buffer.alloc(1 + 8 + NODE_ID_LEN);
  buf[0] = MSG_FIND_VALUE;
  messageId.copy(buf, 1);
  key.copy(buf, 9);
  return buf;
}

export function decodeFindValue(buf) {
  if (buf.length < 1 + 8 + NODE_ID_LEN) {
    throw new Error('Malformed FIND_VALUE message');
  }

  const messageId = buf.subarray(1, 9);
  const key = buf.subarray(9, 9 + NODE_ID_LEN);

  return { messageId, key };
}

export function encodeFindValueResponse(messageId, value, nodes = []) {
  if (value) {
    const valueBuf = Buffer.from(value);
    const buf = Buffer.alloc(1 + 8 + 1 + 4 + valueBuf.length);
    buf[0] = MSG_FIND_VALUE_RESPONSE;
    messageId.copy(buf, 1);
    buf[9] = 1;
    buf.writeUInt32BE(valueBuf.length, 10);
    valueBuf.copy(buf, 14);
    return buf;
  }

  const buf = Buffer.alloc(1 + 8 + 1 + 1 + nodes.length * NODE_ID_LEN);
  buf[0] = MSG_FIND_VALUE_RESPONSE;
  messageId.copy(buf, 1);
  buf[9] = 0;
  buf[10] = nodes.length;
  nodes.forEach((n, i) => n.copy(buf, 11 + i * NODE_ID_LEN));
  return buf;
}

export function decodeFindValueResponse(buf) {
  const messageId = buf.subarray(1, 9);
  const found = buf[9] === 1;

  if (found) {
    const len = buf.readUInt32BE(10);
    const value = buf.subarray(14, 14 + len);
    return { messageId, value };
  }

  const count = buf[10];
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(buf.subarray(11 + i * NODE_ID_LEN, 11 + (i + 1) * NODE_ID_LEN));
  }

  return { messageId, nodes };
}
