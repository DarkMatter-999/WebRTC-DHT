import {
  createNodeId,
  decodeMessage,
  encodePing,
  encodePong,
  encodeFindNode,
  encodeFindNodeResponse,
  decodeFindNode,
  decodeFindNodeResponse,
  xorDistance,
  compareDistance,
} from './utils.js';

import {
  NODE_ID_LEN,
  MSG_PING,
  MSG_PONG,
  MSG_FIND_NODE,
  MSG_FIND_NODE_RESPONSE,
} from './constants.js';
import { ConnectionManager } from './connection-manager.js';
import { RoutingTable } from './routing-table.js';

export class PeerNode {
  constructor({ signalingUrl }) {
    this.signalingUrl = signalingUrl;

    this.peerId = createNodeId();
    this.peerIdHex = this.peerId.toString('hex');

    this.onFindNodeResponse = null;
    this.onPeerConnected = null;

    this.conn = new ConnectionManager({
      nodeId: this.peerId,
      signalingUrl,
    });

    this.routingTable = new RoutingTable({
      nodeId: this.peerId,
      k: 20,
    });

    this.conn.on('message', (peerId, buf) => this.handleMessage(peerId, buf));

    this.conn.on('peerConnected', (peerIdHex) => {
      const nodeId = Buffer.from(peerIdHex, 'hex');

      this.routingTable.addNode(nodeId);
      this.onPeerConnected?.(peerIdHex);
    });

    this.conn.on('peerDisconnected', (peerIdHex) => {
      this.routingTable.removeNode(Buffer.from(peerIdHex, 'hex'));
    });
  }

  start() {
    console.log('Connecting to signalling server at', this.signalingUrl);
    this.conn.start();
  }

  handleMessage(peerIdHex, buf) {
    const { type, content } = decodeMessage(buf);

    switch (type) {
      case MSG_PING: {
        const nodeId = content.subarray(0, NODE_ID_LEN);
        const nodeIdHex = nodeId.toString('hex');

        if (!nodeId.equals(this.peerId)) {
          console.log('PING from', nodeIdHex);
          this.conn.send(peerIdHex, encodePong(this.peerId));
        }
        break;
      }

      case MSG_PONG: {
        const nodeId = content.subarray(0, NODE_ID_LEN);
        const nodeIdHex = nodeId.toString('hex');
        this.routingTable.touch(nodeId);

        if (!nodeId.equals(this.peerId)) {
          console.log('PONG from', nodeIdHex);
        }
        break;
      }

      case MSG_FIND_NODE: {
        const targetNodeId = decodeFindNode(buf);

        const closest = this.routingTable.findClosest(targetNodeId, 3);
        this.conn.send(peerIdHex, encodeFindNodeResponse(closest));
        break;
      }

      case MSG_FIND_NODE_RESPONSE: {
        const nodes = decodeFindNodeResponse(buf);
        console.log(
          'FIND_NODE response:',
          nodes.map((id) => id.toString('hex'))
        );
        this.onFindNodeResponse?.(nodes);
        break;
      }

      default:
        console.log('Unknown message type:', type);
    }
  }

  ping(peerIdHex) {
    this.conn.send(peerIdHex, encodePing(this.peerId));
  }

  findNode(targetNodeId) {
    for (const peerId of this.conn.getConnectedPeers()) {
      this.conn.send(peerId, encodeFindNode(targetNodeId));
    }
  }

  async connect(targetPeerId) {
    await this.conn.connect(targetPeerId);
    console.log('Sent offer to', targetPeerId);
  }
}
