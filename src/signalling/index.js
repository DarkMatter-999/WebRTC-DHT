/**
 * Signalling server for WebRTC peer discovery and message relay.
 * - Accept WebSocket connections from peers
 * - Register peers by ID
 * - Relay signalling messages (offer/answer/ICE)
 * - Return a list of closest peers based on XOR distance
 */

import { WebSocketServer } from 'ws';
import 'dotenv/config';
import { xorDistance, compareDistance } from '../peer/utils.js';

/**
 * WebSocket signalling server instance.
 * - Port is read from SIGNALLING_PORT env var (defaults to 3000)
 * - Listens on all network interfaces (0.0.0.0)
 */
const wss = new WebSocketServer({
  port: Number(process.env.SIGNALLING_PORT || 3000),
  host: '0.0.0.0',
});

/**
 * Map of connected peers.
 *
 * Key:   peerId (hex string)
 * Value: WebSocket connection associated with the peer
 *
 * @type {Map<string, import('ws').WebSocket>}
 */
const peers = new Map();

console.log(
  `Signalling server running on port: ${process.env.SIGNALLING_PORT}`
);

/**
 * Handle new WebSocket connections.
 *
 * Each connection represents a single peer.
 */
wss.on('connection', function connection(ws) {
  let peerId = null;

  /**
   * Handle incoming messages from a peer.
   *
   * Expected message format:
   * {
   *   type: 'register' | 'offer' | 'answer' | 'ice' | 'get-peers',
   *   peerId?: string,
   *   to?: string,
   *   ...payload
   * }
   */
  ws.on('message', function incoming(message) {
    const msg = JSON.parse(message);

    switch (msg.type) {
      case 'register':
        peerId = msg.peerId;
        peers.set(peerId, ws);
        console.log(`Currently connected peers:`, [...peers.keys()]);
        break;

      case 'offer':
      case 'answer':
      case 'ice':
        const targetPeer = peers.get(msg.to);
        if (targetPeer) {
          targetPeer.send(JSON.stringify(msg));
        }
        break;

      case 'get-peers':
        const peerIds = Array.from(peers.keys()).filter((id) => id !== peerId);

        const peersWithDistance = peerIds.map((id) => {
          const distance = xorDistance(
            Buffer.from(peerId, 'hex'),
            Buffer.from(id, 'hex')
          );
          return { id, distance };
        });

        peersWithDistance.sort((a, b) =>
          compareDistance(a.distance, b.distance)
        );

        const closestPeers = peersWithDistance.slice(0, 5).map((p) => p.id);

        ws.send(
          JSON.stringify({
            type: 'peers',
            peers: closestPeers,
          })
        );
        break;
    }
  });

  /**
   * Cleanup when a peer disconnects.
   * Removes the peer from the registry.
   */
  ws.on('close', () => {
    if (peerId) peers.delete(peerId);
  });
});
