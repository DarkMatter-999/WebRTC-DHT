import WebSocket from 'ws';
import wrtc from 'wrtc';
import { createNodeId } from './utils.js';

const SIGNAL_URL = `ws://localhost:${process.env.SIGNALLING_PORT || 3000}`;
const peerId = createNodeId();
const peerIdStr = peerId.toString('hex');
console.log('Peer ID:', peerIdStr);

const socket = new WebSocket(SIGNAL_URL);

let pc;
let channel;
let targetPeerId = null;
let signalingClosed = false;

socket.on('open', () => {
  console.log('Connected to signaling');

  socket.send(JSON.stringify({ type: 'register', peerId: peerIdStr }));
  socket.send(JSON.stringify({ type: 'get-peers' }));
});

socket.on('message', async (data) => {
  const msg = JSON.parse(data);

  if ('peers' === msg.type  && msg?.peers?.length && !pc) {
    const otherIdStr = msg.peers[0];
      targetPeerId = otherIdStr;
      await startConnection();
  }

  if ('offer' === msg.type) {
    targetPeerId = msg.from;
    await acceptOffer(msg.sdp);
  }

  if ('answer' === msg.type) {
    await pc.setRemoteDescription(msg?.sdp);
  }

  if ('ice' === msg.type) {
    await pc.addIceCandidate(msg?.candidate);
  }
});

async function startConnection() {
  pc = createPeerConnection();

  channel = pc.createDataChannel('dht');
  setupChannel(channel);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.send(
    JSON.stringify({
      type: 'offer',
      from: peerIdStr,
      to: targetPeerId,
      sdp: offer,
    })
  );
}

async function acceptOffer(offer) {
  pc = createPeerConnection();

  pc.ondatachannel = (e) => {
    channel = e.channel;
    setupChannel(channel);
  };

  await pc.setRemoteDescription(offer);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.send(
    JSON.stringify({
      type: 'answer',
      from: peerIdStr,
      to: targetPeerId,
      sdp: answer,
    })
  );
}

function createPeerConnection() {
  const pc = new wrtc.RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.send(
        JSON.stringify({
          type: 'ice',
          from: peerIdStr,
          to: targetPeerId,
          candidate: e.candidate,
        })
      );
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Connection state:', pc.connectionState);

    if (pc.iceConnectionState === 'connected' && !signalingClosed) {
      signalingClosed = true;
      console.log('P2P connected, closing signaling');
      socket.close();
    }
  };

  return pc;
}

function setupChannel(ch) {
  ch.binaryType = 'arraybuffer';

  ch.onopen = () => {
    console.log('DataChannel open');

    const buf = Buffer.from(peerId, 'hex');
    ch.send(buf);
  };

  ch.onmessage = (e) => {
    const data = Buffer.from(e.data);
    console.log('Received peer ID:', data.toString('hex'));
  };
}
