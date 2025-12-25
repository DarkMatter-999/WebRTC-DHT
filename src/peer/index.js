import { PeerNode } from './peer-node.js';

const SIGNAL_URL = `ws://localhost:${process.env.SIGNALLING_PORT || 3000}`;

const node = new PeerNode({ signalingUrl: SIGNAL_URL });

console.log('Peer ID:', node.peerIdHex);

node.onPeerConnected = (peerId) => {
  console.log('Connected to peer:', peerId);
};

node.start();
