# WebRTC-DHT

A **Kademlia-style Distributed Hash Table (DHT)** implemented in JavaScript using **WebRTC data channels** for peer-to-peer communication and a **WebSocket signaling server** for bootstrapping.

This project demonstrates a decentralized key–value store where peers discover each other, route messages, and replicate data **without a central data service**.

---

## Features

- Peer-to-peer networking via **WebRTC**
- Bootstrap signaling using **WebSockets**
- Kademlia routing table (k-buckets, XOR distance)
- Iterative `FIND_NODE` and `FIND_VALUE` lookups
- Distributed key–value storage with replication and quorum
- Automatic refresh, republish, and repair
- Peer liveness detection (PING / PONG)
- Interactive CLI client
- **Docker-based multi-peer orchestration**

---

## Core Components

### Signaling Server

- Used only for peer discovery and WebRTC negotiation
- Can be closed once the DHT is connected

### ConnectionManager

- Manages WebRTC peer connections
- Routes signaling messages over the DHT when possible
- Handles heartbeats and peer lifecycle

### RoutingTable

- Implements Kademlia k-buckets
- Buckets indexed by first differing XOR bit
- LRU eviction with replacement nodes

### PeerNode

- Implements DHT protocol logic
- Handles routing, storage, replication, and repair
- Exposes a simple API (`storeValue`, `findValue`, etc.)

---

## Kademlia Parameters

| Parameter       | Value    |
| --------------- | -------- |
| Node ID size    | 256 bits |
| Bucket size (k) | 20       |
| Parallelism (α) | 3        |
| Distance metric | XOR      |
| Write quorum    | ⌈k / 2⌉  |

---

## Installation

```bash
git clone https://github.com/DarkMatter-999/webrtc-dht.git
cd webrtc-dht
npm install
```

---

## Configuration

The signaling server address is configured via environment variables:

```bash
SIGNALLING_HOST=localhost
SIGNALLING_PORT=3000
```

Defaults are used if not provided.

---

## Running Without Docker

### Start the Signaling Server

```bash
npm run signalling
```

### Start One or More Peers

```bash
npm run peer
```

Run this in multiple terminals or machines to form a network.

---

### Interactive Client

```bash
npm run client
```

Provides a REPL for exploring the DHT.

---

## Docker Deployment (Recommended)

The project includes a **Node-based Docker orchestration script** that wraps `docker compose` and makes it easy to spin up multiple peers.

### Available Commands

```bash
npm run docker -- build
npm run docker -- up --peers 3
npm run docker -- down
npm run docker -- all --peers 5
```

### Commands Explained

| Command | Description                                      |
| ------- | ------------------------------------------------ |
| `build` | Build all Docker images                          |
| `up`    | Start containers (`--peers N` scales peer nodes) |
| `down`  | Stop and remove containers                       |
| `all`   | Build and start everything                       |

### Example

Start a 25-node DHT cluster:

```bash
npm run docker -- all --peers 25
```

This will:

1. Build images
2. Start the signaling server
3. Start 25 peer nodes
4. Automatically connect them into a DHT

---

## CLI Commands (Client)

```
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
```

---

## Data Model

Each stored value is wrapped in a versioned record:

```js
{
  data: "<base64>",
  ts: <timestamp>,
  pub: "<publisher node id>"
}
```

- Records are ordered by timestamp, then publisher ID
- Expired values are automatically cleaned up
- Cached values use a shorter TTL

---

## Background Maintenance

Each peer runs periodic maintenance tasks:

- **Bucket refresh** - probes idle routing buckets
- **Republish** - republishes authored values
- **Replica repair** - restores missing replicas
- **Liveness checks** - evicts unresponsive peers

---

## Development

### Linting

```bash
npm run lint
```

### Formatting

```bash
npm run format
```

---

## Limitations

- NAT traversal relies on public STUN servers
- No persistent storage (memory only)
- No authentication or encryption beyond WebRTC defaults
- Intended for experimentation and learning, not production use
