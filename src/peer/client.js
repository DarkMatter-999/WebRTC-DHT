import readline from 'readline';
import { PeerNode } from './peer-node.js';

const SIGNAL_URL = `ws://localhost:${process.env.SIGNALLING_PORT || 3000}`;

const node = new PeerNode({ signalingUrl: SIGNAL_URL });

console.log('Client Node ID:', node.peerIdHex);

node.onFindNodeResponse = (nodes) => {
  console.log(
    'FIND_NODE response:',
    nodes.map((n) => n.toString('hex'))
  );
};

node.start();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.on('line', (line) => {
  const [cmd, arg] = line.trim().split(' ');

  if (cmd === 'peers') {
    console.log(node.getPeers());
  }

  if (cmd === 'ping') {
    node.ping(arg);
  }

  if (cmd === 'find') {
    node.findNode(Buffer.from(arg, 'hex'));
  }
});
