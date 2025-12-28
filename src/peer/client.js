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

  switch (cmd) {
    case 'peers':
      console.log(node?.conn?.getConnectedPeers());
      break;

    case 'ping':
      node.ping(arg);
      break;

    case 'find':
      node.findNode(Buffer.from(arg, 'hex'));
      break;

    case 'connect':
      node.connect(arg);
      break;

    default:
      console.log(
        'Unknown command. Available commands: peers | ping <peerId> | find <nodeId> | connect <peerId>'
      );
  }
});
