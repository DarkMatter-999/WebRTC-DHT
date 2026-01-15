import 'dotenv/config';
import { PeerNode } from './peer-node.js';

/**
 * Bootstrap entrypoint for a DHT peer node.
 *
 * This script:
 * - Loads configuration from environment variables
 * - Creates a PeerNode instance
 * - Connects to the signaling server
 * - Logs peer connections as they occur
 *
 * Intended usage:
 * - Run multiple instances to form a DHT network
 * - Acts as a long-running background node
 */

const SIGNAL_URL = `ws://${process.env.SIGNALLING_HOST || 'localhost'}:${process.env.SIGNALLING_PORT || 3000}`;

const node = new PeerNode({ signalingUrl: SIGNAL_URL });

console.log('Peer ID:', node.peerIdHex);

node.onPeerConnected = (peerId) => {
  console.log('Connected to peer:', peerId);
};

node.start();
