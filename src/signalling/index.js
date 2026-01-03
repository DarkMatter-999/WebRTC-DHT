import { WebSocketServer } from 'ws';
import 'dotenv/config';
import { xorDistance, compareDistance } from '../peer/utils.js';

const wss = new WebSocketServer({
  port: Number(process.env.SIGNALLING_PORT || 3000),
  host: '0.0.0.0',
});
const peers = new Map();

console.log(
  `Signalling server running on port: ${process.env.SIGNALLING_PORT}`
);

wss.on('connection', function connection(ws) {
  let peerId = null;

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

  ws.on('close', () => {
    if (peerId) peers.delete(peerId);
  });
});
