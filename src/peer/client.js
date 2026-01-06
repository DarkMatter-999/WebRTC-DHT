import readline from 'readline';
import { PeerNode } from './peer-node.js';

const SIGNAL_URL = `ws://${process.env.SIGNALLING_HOST || 'localhost'}:${process.env.SIGNALLING_PORT || 3000}`;

const node = new PeerNode({ signalingUrl: SIGNAL_URL });

console.log('Client Node ID:', node.peerIdHex);

node.onFindNodeResponse = (nodes) => {
  console.log(
    'FIND_NODE response:',
    nodes.map((n) => n.toString('hex'))
  );
};

node.onPeerConnected = (peerIdHex) => {
  console.log('Connected to peer:', peerIdHex);
};

node.start();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function isValidHexId(hex, expectedBytes = 32) {
  return (
    typeof hex === 'string' &&
    /^[0-9a-fA-F]+$/.test(hex) &&
    hex.length === expectedBytes * 2
  );
}

rl.on('line', (line) => {
  const [cmd, arg] = line.trim().split(/\s+/);

  switch (cmd) {
    case 'id':
      console.log('Node ID:', node.peerIdHex);
      break;

    case 'peers':
      console.log('Connected peers:', node.conn.getConnectedPeers());
      break;

    case 'rt':
      console.log('Routing table size:', node.routingTable.size());
      break;

    case 'dump':
      console.dir(node.routingTable.dump(), { depth: null });
      break;

    case 'ping':
      if (!isValidHexId(arg)) {
        console.log('Usage: ping <64-hex-node-id>');
        break;
      }
      node.ping(arg);
      break;

    case 'find':
      if (!isValidHexId(arg)) {
        console.log('Usage: find <64-hex-node-id>');
        break;
      }
      node.iterativeFindNode(Buffer.from(arg, 'hex'));
      break;

    case 'connect':
      if (!isValidHexId(arg)) {
        console.log('Usage: connect <64-hex-node-id>');
        break;
      }
      if (arg === node.peerIdHex) {
        console.log('Cannot connect to self');
        break;
      }
      node.connect(arg);
      break;

    case 'help':
      console.log(`
Available commands:
  id                     Show this node's ID
  peers                  List connected peers
  rt                     Routing table size
  dump                   Dump routing table buckets
  ping <nodeId>          Ping a peer
  find <nodeId>          FIND_NODE lookup
  connect <nodeId>       Connect to peer
  help                   Show this help
`);
      break;

    default:
      console.log('Unknown command. Type "help" for list of commands.');
  }
});
