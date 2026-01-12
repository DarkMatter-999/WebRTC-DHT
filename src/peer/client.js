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

rl.on('line', async (line) => {
  const [cmd, ...args] = line.trim().split(/\s+/);

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

    case 'ping': {
      const [peerId] = args;
      if (!isValidHexId(peerId)) {
        console.log('Usage: ping <64-hex-node-id>');
        break;
      }
      node.ping(peerId);
      break;
    }

    case 'find': {
      const [nodeId] = args;
      if (!isValidHexId(nodeId)) {
        console.log('Usage: find <64-hex-node-id>');
        break;
      }
      const res = await node.iterativeFindNode(Buffer.from(nodeId, 'hex'));
      console.log(
        'Closest nodes:',
        res.map((n) => n.toString('hex'))
      );
      break;
    }

    case 'connect': {
      const [peerId] = args;
      if (!isValidHexId(peerId)) {
        console.log('Usage: connect <64-hex-node-id>');
        break;
      }
      if (peerId === node.peerIdHex) {
        console.log('Cannot connect to self');
        break;
      }
      node.connect(peerId);
      break;
    }

    case 'store': {
      if (args.length < 2) {
        console.log('Usage: store <key> <value>');
        break;
      }
      const key = args[0];
      const value = args.slice(1).join(' ');

      console.log(`Storing key="${key}" value="${value}"`);
      try {
        await node.storeValue(key, value);
        console.log('Store complete (quorum reached)');
      } catch (err) {
        console.error('Store failed:', err.message);
        console.log('Value NOT committed to the DHT.');
      }
      break;
    }

    case 'get': {
      if (args.length !== 1) {
        console.log('Usage: get <key>');
        break;
      }
      const key = args[0];

      console.log(`Looking up key="${key}"`);
      const value = await node.findValue(key);

      if (value) {
        console.log('Value found:', value.toString());
      } else {
        console.log('Value not found');
      }
      break;
    }

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
  store <key> <value>    STORE a value in the DHT
  get <key>              FIND_VALUE lookup
  help                   Show this help
`);
      break;

    default:
      console.log('Unknown command. Type "help" for list of commands.');
  }
});
