import { WebSocketServer } from "ws";
import "dotenv/config";

const wss = new WebSocketServer({
  port: Number(process.env.SIGNALLING_PORT),
});
const peers = new Map();

console.log(
  `Signalling server running on port: ${process.env.SIGNALLING_PORT}`,
);

wss.on("connection", function connection(ws) {
  let peerId = null;

  console.log(`Currently connected peers:`, [...peers.keys()]);

  ws.on("message", function incoming(message) {
    const msg = JSON.parse(message);

    switch (msg.type) {
      case "register":
        peerId = msg.peerId;
        peers.set(peerId, ws);
        break;

      case "offer":
      case "answer":
      case "ice":
        const targetPeer = peers.get(msg.to);
        if (targetPeer) {
          targetPeer.send(JSON.stringify(msg));
        }
        break;

      case "get-peers":
        ws.send(
          JSON.stringify({
            type: "peers",
            peers: [...peers.keys()].filter((id) => id !== peerId),
          }),
        );
        break;
    }
  });

  ws.on("close", () => {
    if (peerId) peers.delete(peerId);
  });
});
