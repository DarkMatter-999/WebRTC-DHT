import crypto from 'crypto';

import {
  MSG_FIND_NODE,
  MSG_FIND_NODE_RESPONSE,
  MSG_FIND_VALUE,
  MSG_FIND_VALUE_RESPONSE,
  MSG_PING,
  MSG_PONG,
  MSG_STORE,
  MSG_STORE_ACK,
  NODE_ID_LEN,
} from './constants.js';

/**
 * Generate a cryptographically secure node ID.
 * Uses SHA-256(random 32 bytes).
 *
 * @returns {Buffer} 32-byte node ID
 */
export function createNodeId() {
  return crypto.createHash('sha256').update(crypto.randomBytes(32)).digest();
}

/**
 * Generate an 8-byte message ID for request/response correlation.
 *
 * @returns {Buffer}
 */
export function generateMessageId() {
  return crypto.randomBytes(8);
}

/**
 * Generate a random node ID without hashing.
 *
 * @returns {Buffer}
 */
export function randomNodeId() {
  return crypto.randomBytes(32);
}

/**
 * Derive a DHT key ID from an arbitrary key.
 *
 * @param {string|Buffer} key
 * @returns {Buffer}
 */
export function generateKeyId(key) {
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encode a PING message.
 *
 * Format:
 * [type=PING][nodeId]
 *
 * @param {Buffer} nodeId
 * @returns {Buffer}
 */
export function encodePing(nodeId) {
  return Buffer.concat([Buffer.from([MSG_PING]), Buffer.from(nodeId)]);
}

/**
 * Encode a PONG message.
 *
 * @param {Buffer} nodeId
 * @returns {Buffer}
 */
export function encodePong(nodeId) {
  return Buffer.concat([Buffer.from([MSG_PONG]), Buffer.from(nodeId)]);
}

/**
 * Decode a generic message.
 *
 * @param {Buffer} buf
 * @returns {{type: number, content: Buffer}}
 */
export function decodeMessage(buf) {
  if (buf.length < 1) throw new Error('Malformed message');

  return {
    type: buf[0],
    content: buf.subarray(1),
  };
}

/**
 * Compute XOR distance between two buffers.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Buffer}
 */
export function xorDistance(a, b) {
  const buf = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    buf[i] = a[i] ^ b[i];
  }
  return buf;
}

/**
 * Compare two XOR distances lexicographically.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {number}
 */
export function compareDistance(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Encode FIND_NODE request.
 *
 * @param {Buffer} messageId 8 bytes
 * @param {Buffer} targetNodeId
 * @returns {Buffer}
 */
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

/**
 * Encode FIND_NODE response.
 *
 * @param {Buffer} messageId
 * @param {Buffer[]} nodeIds
 * @returns {Buffer}
 */
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

/**
 * Decode FIND_NODE request.
 *
 * @param {Buffer} buf
 * @returns {{messageId: Buffer, targetNodeId: Buffer}}
 */
export function decodeFindNode(buf) {
  const messageId = buf.subarray(1, 9);
  const targetNodeId = buf.subarray(9, 9 + NODE_ID_LEN);
  return { messageId, targetNodeId };
}

/**
 * Decode FIND_NODE response.
 *
 * @param {Buffer} buf
 * @returns {{messageId: Buffer, nodes: Buffer[]}}
 */
export function decodeFindNodeResponse(buf) {
  const messageId = buf.subarray(1, 9);
  const count = buf[9];

  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(buf.subarray(10 + i * NODE_ID_LEN, 10 + (i + 1) * NODE_ID_LEN));
  }
  return { messageId, nodes };
}

/**
 * Encode a routed DHT signaling message.
 *
 * @param {number} type
 * @param {object} payload
 * @returns {Buffer}
 */
export function encodeSignal(type, payload) {
  if (!payload.messageId) {
    payload.messageId = generateMessageId().toString('hex');
  }

  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf = Buffer.alloc(1 + payloadBuf.length);
  buf[0] = type;
  payloadBuf.copy(buf, 1);
  return buf;
}

/**
 * Decode a routed DHT signaling message.
 *
 * @param {Buffer} buf
 * @returns {{type: number, payload: any}}
 */
export function decodeSignal(buf) {
  const type = buf[0];
  const payload = JSON.parse(buf.subarray(1).toString());

  if (!payload.messageId) {
    throw new Error('Signal payload missing messageId');
  }

  return { type, payload };
}

/**
 * Encode STORE message.
 *
 * @param {Buffer} messageId
 * @param {Buffer} key
 * @param {object} record
 * @returns {Buffer}
 */
export function encodeStore(messageId, key, record) {
  const json = JSON.stringify(record);
  const valueBuf = Buffer.from(json);
  const buf = Buffer.alloc(1 + 8 + NODE_ID_LEN + 4 + valueBuf.length);

  buf[0] = MSG_STORE;
  messageId.copy(buf, 1);
  key.copy(buf, 9);
  buf.writeUInt32BE(valueBuf.length, 9 + NODE_ID_LEN);
  valueBuf.copy(buf, 13 + NODE_ID_LEN);

  return buf;
}

/**
 * Decode STORE message.
 *
 * @param {Buffer} buf
 * @returns {{messageId: Buffer, key: Buffer, record: object}}
 */
export function decodeStore(buf) {
  const messageId = buf.subarray(1, 9);
  const key = buf.subarray(9, 9 + NODE_ID_LEN);
  const len = buf.readUInt32BE(9 + NODE_ID_LEN);
  const json = buf
    .subarray(13 + NODE_ID_LEN, 13 + NODE_ID_LEN + len)
    .toString();
  const record = JSON.parse(json);

  return { messageId, key, record };
}

/**
 * Encode FIND_VALUE message.
 *
 * @param {Buffer} messageId
 * @param {Buffer} key
 * @returns {Buffer}
 */
export function encodeFindValue(messageId, key) {
  const buf = Buffer.alloc(1 + 8 + NODE_ID_LEN);
  buf[0] = MSG_FIND_VALUE;
  messageId.copy(buf, 1);
  key.copy(buf, 9);
  return buf;
}

/**
 * Decode FIND_VALUE message.
 *
 * @param {Buffer} buf
 * @returns {{messageId: Buffer, key: Buffer}}
 */
export function decodeFindValue(buf) {
  if (buf.length < 1 + 8 + NODE_ID_LEN) {
    throw new Error('Malformed FIND_VALUE message');
  }

  const messageId = buf.subarray(1, 9);
  const key = buf.subarray(9, 9 + NODE_ID_LEN);

  return { messageId, key };
}

/**
 * Encode FIND_VALUE response.
 *
 * @param {Buffer} messageId
 * @param {object|null} record
 * @param {Buffer[]} nodes
 * @returns {Buffer}
 */
export function encodeFindValueResponse(messageId, record, nodes = []) {
  if (record) {
    const json = JSON.stringify(record);
    const valueBuf = Buffer.from(json);
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

/**
 * Decode FIND_VALUE response.
 *
 * @param {Buffer} buf
 * @returns {{messageId: Buffer, record?: object, nodes?: Buffer[]}}
 */
export function decodeFindValueResponse(buf) {
  const messageId = buf.subarray(1, 9);
  const found = buf[9] === 1;

  if (found) {
    const len = buf.readUInt32BE(10);
    const json = buf.subarray(14, 14 + len).toString();
    const record = JSON.parse(json);
    return { messageId, record };
  }

  const count = buf[10];
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(buf.subarray(11 + i * NODE_ID_LEN, 11 + (i + 1) * NODE_ID_LEN));
  }

  return { messageId, nodes };
}

/**
 * Encode STORE_ACK message.
 *
 * @param {Buffer} messageId
 * @returns {Buffer}
 */
export function encodeStoreAck(messageId) {
  return Buffer.concat([Buffer.from([MSG_STORE_ACK]), messageId]);
}

/**
 * Decode STORE_ACK message.
 *
 * @param {Buffer} buf
 * @returns {{messageId: Buffer}}
 */
export function decodeStoreAck(buf) {
  return {
    messageId: buf.subarray(1),
  };
}

/**
 * Encode HAS_VALUE message.
 *
 * @param {Buffer} messageId
 * @param {Buffer} key
 * @returns {Buffer}
 */
export function encodeHasValue(messageId, key) {
  const buf = Buffer.alloc(1 + 8 + NODE_ID_LEN);
  buf[0] = MSG_HAS_VALUE;
  messageId.copy(buf, 1);
  key.copy(buf, 9);
  return buf;
}

/**
 * Decode HAS_VALUE message.
 *
 * @param {Buffer} buf
 * @returns {{messageId: Buffer, key: Buffer}}
 */
export function decodeHasValue(buf) {
  return {
    messageId: buf.subarray(1, 9),
    key: buf.subarray(9, 9 + NODE_ID_LEN),
  };
}

/**
 * Encode HAS_VALUE response.
 *
 * @param {Buffer} messageId
 * @param {boolean} has
 * @returns {Buffer}
 */
export function encodeHasValueResponse(messageId, has) {
  const buf = Buffer.alloc(1 + 8 + 1);
  buf[0] = MSG_HAS_VALUE_RESPONSE;
  messageId.copy(buf, 1);
  buf[9] = has ? 1 : 0;
  return buf;
}

/**
 * Decode HAS_VALUE response.
 *
 * @param {Buffer} buf
 * @returns {{messageId: Buffer, has: boolean}}
 */
export function decodeHasValueResponse(buf) {
  return {
    messageId: buf.subarray(1, 9),
    has: buf[9] === 1,
  };
}
