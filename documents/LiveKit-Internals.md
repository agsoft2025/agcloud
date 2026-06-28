# LiveKit Internals: Technical Deep Dive

> **Date:** 2026-04-16
> **Scope:** Detailed technical analysis of LiveKit's signaling, protocols, architecture, and deployment
> **Context:** Evaluating LiveKit as the core media infrastructure for agcloud

---

## Table of Contents
1. [Signaling Protocol](#1-signaling-protocol)
2. [Client Join Flow](#2-client-join-flow)
3. [What LiveKit Handles vs What You Build](#3-what-livekit-handles-vs-what-you-build)
4. [Call Initiation Pattern](#4-call-initiation-pattern)
5. [Proxy & Network Requirements](#5-proxy--network-requirements)
6. [Backend-to-LiveKit Communication](#6-backend-to-livekit-communication)
7. [Node.js Server SDK](#7-nodejs-server-sdk)
8. [TURN Integration](#8-turn-integration)
9. [Multi-Node Scaling](#9-multi-node-scaling)
10. [Deployment Topology](#10-deployment-topology)

---

## 1. Signaling Protocol

LiveKit uses **WebSocket + Protocol Buffers (protobuf)** for signaling — not JSON.

| Aspect | Detail |
|--------|--------|
| Transport | WebSocket (WSS in production) |
| Wire format | Protocol Buffers (binary, compact, fast) |
| Protobuf definitions | `livekit/protocol` GitHub repo |
| Endpoint | `wss://<livekit-host>/rtc?access_token=<jwt>` |

### Message Types

Two primary signaling message types exist, both are union types wrapping all possible signaling messages:

| Message Type | Direction | Contains |
|-------------|-----------|----------|
| `SignalRequest` | Client -> Server | Join, SDP offer/answer, ICE candidates, track publish, mute, metadata updates |
| `SignalResponse` | Server -> Client | JoinResponse, SDP offer/answer, ICE candidates, track subscribed, participant updates, speaker changes |

### Dual PeerConnection Design

LiveKit uses **two PeerConnections per participant** — a deliberate design choice for SFU efficiency:

| PeerConnection | Direction | Purpose |
|----------------|-----------|---------|
| **Publisher** | Client -> Server | Client sends SDP offer when publishing tracks |
| **Subscriber** | Server -> Client | Server sends SDP offer when delivering remote tracks |

This split avoids renegotiation storms — publishing and subscribing are independent SDP negotiations.

---

## 2. Client Join Flow

Step-by-step trace of what happens when a client joins a room:

```
Step 1: Token Generation (Your Backend)
    Your Node.js backend calls AccessToken (server SDK)
    Creates a signed JWT with:
      - Room name
      - Participant identity
      - Permissions (canPublish, canSubscribe, canPublishData, etc.)
            |
            v
Step 2: Client Connects
    Client receives token
    Calls room.connect(livekitUrl, token)
            |
            v
Step 3: WebSocket Handshake
    Client SDK opens WebSocket to:
    wss://<livekit-host>/rtc?access_token=<jwt>
            |
            v
Step 4: Server Validates & Responds
    Server validates JWT signature + expiry
    Adds participant to room
    Sends JoinResponse containing:
      - Room state (existing participants, their tracks)
      - Server-generated SDP offer (for subscriber PeerConnection)
      - ICE servers configuration
            |
            v
Step 5: SDP Answer (Subscriber)
    Client sets remote description from server's SDP offer
    Creates SDP answer
    Sends answer back over WebSocket
            |
            v
Step 6: ICE Candidate Exchange
    ICE candidates exchanged over the same WebSocket
    Both PeerConnections negotiate connectivity
    Candidates include:
      - Host candidates (local IPs)
      - Server-reflexive candidates (via STUN)
      - Relay candidates (via embedded TURN)
            |
            v
Step 7: Track Publishing (Publisher)
    When client publishes a track (audio/video/screen):
    Client creates SDP offer on publisher PeerConnection
    Sends offer via signaling WebSocket
    Server responds with SDP answer
            |
            v
Step 8: Media Flows
    DTLS handshake completes on both PeerConnections
    SRTP media flows directly over UDP
    LiveKit SFU forwards tracks to subscribers
```

### Connection Timeline

| Phase | Typical Duration | What Happens |
|-------|-----------------|--------------|
| WebSocket open | 50-150ms | TCP + TLS handshake |
| JWT validation + JoinResponse | 10-30ms | Server processes join |
| SDP offer/answer exchange | 50-200ms | Subscriber PeerConnection setup |
| ICE negotiation | 100-500ms | Connectivity checks (depends on network) |
| DTLS + SRTP | 50-100ms | Encryption setup, media starts |
| **Total (best case)** | **~260ms** | Wired network, direct connectivity |
| **Total (TURN relay)** | **~500-800ms** | Firewall-restricted, relay needed |

---

## 3. What LiveKit Handles vs What You Build

### LiveKit Handles (Built-in)

| Capability | Detail |
|-----------|--------|
| Room join/leave | Participant lifecycle management |
| SDP negotiation | Automatic offer/answer for both PeerConnections |
| ICE candidate exchange | Gathering, trickling, connectivity checks |
| Track publish/subscribe/mute | Audio, video, screen share tracks |
| Simulcast | Automatic multi-quality layers (dynacast) |
| Adaptive bitrate | Adjusts quality based on network conditions |
| Participant metadata | Key-value metadata per participant |
| Data channels | Reliable and unreliable data messaging |
| Speaker detection | Active speaker events |
| Connection quality monitoring | Per-participant quality scores |
| Room state synchronization | All participants see consistent state |
| Recording/Egress | Record to file, stream to RTMP, composite layouts |
| Ingress | RTMP/WHIP ingest into rooms |
| Embedded TURN | Relay for firewall-restricted clients |

### You Must Build

| Capability | Why LiveKit Doesn't Handle It |
|-----------|------------------------------|
| **Call initiation (ring/accept/reject/busy)** | LiveKit only knows "rooms," not "calls." No concept of ringing |
| **User authentication** | LiveKit validates JWTs your backend signs — it doesn't manage users |
| **Push notifications** | Needed to wake up the callee (FCM/APNs). LiveKit is unaware of offline users |
| **User presence & contact lists** | Your domain logic — who is online, who can call whom |
| **Call history & CDRs** | Persist call metadata, duration, participants. Use webhooks to capture events |
| **Business logic & permissions** | Who can create rooms, max participants, call duration limits |
| **UI/UX** | LiveKit provides SDKs, not UI. Build your own call screens |
| **Billing & analytics** | Track usage, calculate costs. LiveKit webhooks provide raw events |

---

## 4. Call Initiation Pattern

Since LiveKit has **no concept of "calling someone,"** here is the standard pattern for implementing call initiation:

### Outgoing Call Flow

```
User A (Caller)                Your Backend              LiveKit Server           User B (Callee)
     |                              |                         |                        |
     |-- POST /calls/initiate ----->|                         |                        |
     |   (to: userB)               |                         |                        |
     |                              |-- Create Room --------->|                        |
     |                              |<-- Room Created --------|                        |
     |                              |                         |                        |
     |                              |-- Generate Token A ---->|                        |
     |                              |-- Generate Token B      |                        |
     |                              |                         |                        |
     |<-- Token A + Room Info ------|                         |                        |
     |                              |-- Push Notification ----|----------------------->|
     |                              |   (incoming call from A)|                        |
     |                              |                         |                        |
     |-- room.connect(token A) --->|------- WebSocket ------->|                        |
     |                              |                         |                        |
     |                              |                         |     (User B accepts)   |
     |                              |<-- POST /calls/accept --|------------------------|
     |                              |                         |                        |
     |                              |-- Token B to User B ----|----------------------->|
     |                              |                         |                        |
     |                              |                         |<-- room.connect(token B)
     |                              |                         |                        |
     |<============= Media flows bidirectionally via LiveKit SFU ===================>|
```

### Call States (Your Backend Manages)

| State | Trigger | Action |
|-------|---------|--------|
| `initiating` | Caller requests call | Create room, send push notification |
| `ringing` | Push notification delivered | Start ring timeout (e.g., 30 seconds) |
| `accepted` | Callee accepts | Generate callee token, connect to room |
| `active` | Both participants connected | LiveKit webhook: `participant_joined` |
| `ended` | Either party hangs up | LiveKit webhook: `participant_left` / `room_finished` |
| `rejected` | Callee declines | Clean up room |
| `missed` | Ring timeout expires | Clean up room, notify caller |
| `busy` | Callee is already in a call | Notify caller immediately |

---

## 5. Proxy & Network Requirements

### Can LiveKit Be Exposed Directly?

Yes. LiveKit supports **built-in TLS** via ACME/Let's Encrypt. However, most production deployments use a reverse proxy for flexibility.

| Deployment | Recommendation |
|-----------|----------------|
| Development | Direct exposure, no proxy needed |
| Production (simple) | Direct with built-in TLS |
| Production (standard) | **Caddy or Nginx** in front for WebSocket/API. Media (UDP) goes directly to LiveKit |
| Kubernetes | Ingress controller for HTTP/WS + `hostNetwork` or NodePort for UDP |

### Required Ports

| Port | Protocol | Purpose | Proxy-able? |
|------|----------|---------|-------------|
| **7880** | TCP | HTTP API + WebSocket signaling | Yes (proxy this) |
| **7881** | UDP | WebRTC media (RTP/RTCP) | **No** — must go direct |
| **7882** | TCP | TURN/TLS | Yes (but usually direct) |
| **443** | TCP | TURN over TLS (firewall fallback) | No — LiveKit handles directly |
| **50000-60000** | UDP | WebRTC media port range | **No** — must go direct |

### Proxy Configuration (Nginx Example)

```nginx
# Only proxy the signaling/API — media goes direct
upstream livekit {
    server 127.0.0.1:7880;
}

server {
    listen 443 ssl;
    server_name livekit.yourdomain.com;

    # WebSocket upgrade for signaling
    location / {
        proxy_pass http://livekit;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;  # Keep WebSocket alive
    }
}

# UDP media ports are NOT proxied — they go directly to LiveKit
# Ensure firewall allows UDP 7881 and 50000-60000
```

### Key Rule

**Proxy only handles WebSocket/HTTP (TCP). Media (UDP) always goes directly to the LiveKit process.** This is fundamental to how WebRTC works — proxying UDP media would add unacceptable latency.

---

## 6. Backend-to-LiveKit Communication

LiveKit runs as a **separate process/container**. Your backend communicates with it through three channels:

```
[Your Node.js Backend]
    |                         \
    | Twirp API (HTTP+protobuf) \ Webhooks (HTTP POST)
    | Port 7880                   \ to your endpoint
    |                              \
    v                               v
[LiveKit Server]  <------>  [Redis (multi-node only)]
    |
    | WebSocket (signaling) + UDP (media)
    v
[Clients]
```

### Communication Channels

| Channel | Direction | Protocol | Purpose |
|---------|-----------|----------|---------|
| **Twirp API** | Backend -> LiveKit | HTTP + Protobuf (port 7880) | Room CRUD, participant management, egress control |
| **Webhooks** | LiveKit -> Backend | HTTP POST (JSON) | Event notifications (participant joined/left, track published, room started/finished) |
| **JWT Tokens** | Backend -> Client -> LiveKit | Signed JWT | Authentication & authorization per room/participant |

### Twirp API (Not gRPC)

LiveKit uses **Twirp** — Protobuf-over-HTTP RPC — not raw gRPC, despite using protobuf. This means:
- Standard HTTP/1.1 works (no HTTP/2 requirement)
- Easier to proxy and debug
- Compatible with any HTTP client
- The Node.js server SDK wraps this — you don't call Twirp directly

### Webhook Events

LiveKit sends webhook events to a URL you configure. Your backend receives:

| Event | When |
|-------|------|
| `room_started` | First participant joins a room |
| `room_finished` | Last participant leaves, room is empty |
| `participant_joined` | A participant connects to a room |
| `participant_left` | A participant disconnects |
| `track_published` | A participant starts publishing audio/video |
| `track_unpublished` | A participant stops publishing |
| `egress_started` | Recording/streaming begins |
| `egress_ended` | Recording/streaming completes |
| `ingress_started` | RTMP/WHIP ingest begins |
| `ingress_ended` | Ingest ends |

Webhooks are signed with your API secret — the `WebhookReceiver` class in the server SDK validates signatures for you.

---

## 7. Node.js Server SDK

Package: `livekit-server-sdk`

### Token Generation

```javascript
import { AccessToken } from 'livekit-server-sdk';

function createToken(roomName, participantIdentity) {
  const token = new AccessToken('your-api-key', 'your-api-secret', {
    identity: participantIdentity,
    ttl: '10m',  // Token expires in 10 minutes
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return token.toJwt();
}
```

### Room Management

```javascript
import { RoomServiceClient } from 'livekit-server-sdk';

const roomService = new RoomServiceClient(
  'https://livekit.yourdomain.com',
  'your-api-key',
  'your-api-secret'
);

// Create a room
await roomService.createRoom({ name: 'call-room-123', emptyTimeout: 300 });

// List rooms
const rooms = await roomService.listRooms();

// List participants in a room
const participants = await roomService.listParticipants('call-room-123');

// Remove a participant
await roomService.removeParticipant('call-room-123', 'participant-identity');

// Delete a room
await roomService.deleteRoom('call-room-123');
```

### Egress (Recording)

```javascript
import { EgressClient } from 'livekit-server-sdk';

const egressClient = new EgressClient(
  'https://livekit.yourdomain.com',
  'your-api-key',
  'your-api-secret'
);

// Record room to MP4 file
await egressClient.startRoomCompositeEgress('call-room-123', {
  file: {
    fileType: 'mp4',
    filepath: 's3://your-bucket/recordings/{room_name}/{time}.mp4',
  },
});
```

### Webhook Receiver

```javascript
import { WebhookReceiver } from 'livekit-server-sdk';

const webhookReceiver = new WebhookReceiver('your-api-key', 'your-api-secret');

// Express route handler
app.post('/livekit-webhook', (req, res) => {
  const event = webhookReceiver.receive(req.body, req.get('Authorization'));

  switch (event.event) {
    case 'participant_joined':
      console.log(`${event.participant.identity} joined ${event.room.name}`);
      break;
    case 'participant_left':
      console.log(`${event.participant.identity} left ${event.room.name}`);
      break;
    case 'room_finished':
      console.log(`Room ${event.room.name} closed`);
      // Save call history, calculate duration, etc.
      break;
  }

  res.status(200).send();
});
```

### SDK Capabilities Summary

| Class | Purpose |
|-------|---------|
| `AccessToken` | Create signed JWT tokens with room/participant/permission grants |
| `RoomServiceClient` | Create/delete/list rooms, manage participants (calls Twirp API) |
| `EgressClient` | Start/stop recording, streaming to RTMP |
| `IngressClient` | Manage RTMP/WHIP ingest into rooms |
| `WebhookReceiver` | Validate signatures and parse incoming webhook payloads |
| `SipClient` | SIP trunk management (for PSTN integration) |

---

## 8. TURN Integration

LiveKit has an **embedded TURN server** based on **Pion** (the Go WebRTC library). No separate Coturn deployment needed.

### Configuration

```yaml
# livekit.yaml
turn:
  enabled: true
  domain: livekit.yourdomain.com
  tls_port: 443        # Critical: port 443 bypasses most firewalls
  udp_port: 3478       # Standard TURN UDP port
  external_tls: true   # Set true if TLS is terminated by a load balancer
```

### How ICE Works with Embedded TURN

| Candidate Type | Source | When Used |
|---------------|--------|-----------|
| Host | Client's local IP | Direct LAN connections |
| Server-reflexive (srflx) | STUN response | Client behind simple NAT |
| Relay | Embedded TURN server | Client behind symmetric NAT / firewall blocking UDP |

### Why Port 443 Matters

Most corporate firewalls allow outbound TCP on port 443 (HTTPS). By running TURN on port 443 with TLS, LiveKit ensures connectivity even in the most restrictive networks. This is the single most important configuration for enterprise deployments.

### External TURN (Optional)

You can configure external TURN servers if needed (e.g., for multi-region TURN):

```yaml
# livekit.yaml
rtc:
  turn_servers:
    - host: turn1.yourdomain.com
      port: 443
      protocol: tls
      username: your-username
      credential: your-credential
```

---

## 9. Multi-Node Scaling

For scaling beyond a single server, LiveKit uses **Redis** for inter-node coordination.

### How It Works

```
[Client A]                    [Client B]
    |                              |
    v                              v
[LiveKit Node 1]  <-- Redis -->  [LiveKit Node 2]
   (Region A)      (pub/sub)      (Region B)
```

| Aspect | Detail |
|--------|--------|
| Room routing | Redis tracks which node hosts which room |
| Signaling relay | If participants are on different nodes, signaling is relayed via Redis |
| Media routing | Media can be forwarded between nodes (adds latency) |
| New participant | Routed to the node already hosting the room |
| Configuration | Just add Redis URL to `livekit.yaml` |

### Multi-Node Configuration

```yaml
# livekit.yaml
redis:
  address: redis.yourdomain.com:6379
  password: your-redis-password
  db: 0
```

That's it. LiveKit handles node discovery, room routing, and participant balancing automatically once Redis is configured.

---

## 10. Deployment Topology

### Development (Docker Compose)

```yaml
version: '3.8'
services:
  livekit:
    image: livekit/livekit-server:latest
    ports:
      - "7880:7880"       # API + WebSocket
      - "7881:7881/udp"   # WebRTC media
      - "7882:7882/tcp"   # TURN/TLS
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml
    command: --config /etc/livekit.yaml

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  app-backend:
    build: ./backend
    ports:
      - "3000:3000"
    environment:
      - LIVEKIT_URL=http://livekit:7880
      - LIVEKIT_API_KEY=your-api-key
      - LIVEKIT_API_SECRET=your-api-secret
      - REDIS_URL=redis://redis:6379
      - MONGODB_URI=mongodb://agcloud:your-password@mongodb:27017/agcloud?authSource=admin
    depends_on:
      - livekit
      - redis
      - mongodb

  mongodb:
    image: mongo:7
    ports:
      - "27017:27017"
    environment:
      - MONGO_INITDB_ROOT_USERNAME=agcloud
      - MONGO_INITDB_ROOT_PASSWORD=your-password
      - MONGO_INITDB_DATABASE=agcloud
    volumes:
      - mongodata:/data/db

volumes:
  mongodata:
```

### Production (Single Node)

```
                    [Caddy / Nginx]
                    (TLS termination)
                         |
              +----------+----------+
              |                     |
    [Port 443 - HTTPS/WSS]   [UDP 7881, 50000-60000]
              |                     |
              v                     v
    [Your Node.js API]      [LiveKit Server]
         |      |                |
         v      v                v
    [MongoDB] [Redis] -----------+
```

### Production (Multi-Node Kubernetes)

```
                [Cloud Load Balancer]
                         |
              +----------+----------+
              |                     |
    [Ingress Controller]     [NodePort / hostNetwork]
    (HTTP/WSS traffic)       (UDP media traffic)
              |                     |
    +---------+---------+    +------+------+
    |         |         |    |      |      |
 [API Pod] [API Pod] [API] [LK1] [LK2] [LK3]
    |         |         |    |      |      |
    +---------+---------+----+------+------+
              |                     |
    [MongoDB Replica Set]   [Redis Cluster]
              |
    [S3 / Object Storage]
    (recordings)
```

### Minimum LiveKit Configuration (livekit.yaml)

```yaml
port: 7880
rtc:
  port_range_start: 50000
  port_range_end: 60000
  udp_port: 7881
  use_external_ip: true

keys:
  your-api-key: your-api-secret

turn:
  enabled: true
  domain: livekit.yourdomain.com
  tls_port: 443

# For multi-node only
redis:
  address: redis:6379

# Webhook configuration
webhook:
  urls:
    - https://your-backend.com/livekit-webhook
  api_key: your-api-key
```

---

## Summary

| Question | Answer |
|----------|--------|
| What protocol for signaling? | **WebSocket + Protocol Buffers** |
| Do we need a proxy? | **Optional.** Proxy only TCP (API/WebSocket). UDP media always goes direct to LiveKit |
| Does LiveKit replace custom signaling? | **Partially.** It handles SDP/ICE/room state. You build call initiation (ring/accept/reject) |
| How does our backend talk to LiveKit? | **Twirp API** (HTTP+protobuf) for commands, **Webhooks** for events, **JWT** for auth |
| Do we need a separate TURN server? | **No.** LiveKit has embedded TURN (Pion-based). Port 443/TLS for firewall bypass |
| How does multi-node work? | **Redis** for inter-node coordination. Just add Redis URL to config |
| Can it be self-hosted? | **Yes.** Docker, Docker Compose, Kubernetes (official Helm charts) |
