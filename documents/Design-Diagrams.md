# agcloud: Architecture Design Diagrams

> **Date:** 2026-04-16
> **Scope:** Visual design diagrams comparing the original mediasoup-based approach with the proposed LiveKit-based approach

---

## Table of Contents
1. [Approach A: Original (mediasoup-based)](#approach-a-original-mediasoup-based)
   - 1.1 High-Level Architecture
   - 1.2 Component Architecture
   - 1.3 Call Setup Sequence (1:1)
   - 1.4 Group Call Architecture (SFU)
   - 1.5 Scaling Architecture
2. [Approach B: Proposed (LiveKit-based)](#approach-b-proposed-livekit-based)
   - 2.1 High-Level Architecture
   - 2.2 Component Architecture
   - 2.3 Call Setup Sequence (1:1)
   - 2.4 Group Call Architecture
   - 2.5 Proxy / Load Balancer Layer (Detailed)
   - 2.6 Scaling Architecture
3. [Side-by-Side Comparison](#side-by-side-comparison)

---

# Approach A: Original (mediasoup-based)

## 1.1 High-Level Architecture

```
+----------------------------------------------------------------------+
|                         CLIENT LAYER                                 |
|                                                                      |
|  +----------------+    +----------------+    +----------------+      |
|  |  Web Browser   |    |  Android App   |    |    iOS App     |      |
|  | (Custom WebRTC |    | (libwebrtc +   |    | (libwebrtc +   |      |
|  |   + Socket.IO) |    |  custom SDK)   |    |  custom SDK)   |      |
|  +-------+--------+    +-------+--------+    +-------+--------+      |
|          |                     |                     |               |
+----------|---------------------|---------------------|---------------+
           |                     |                     |
           |  WSS (Socket.IO)    |  WSS                |  WSS
           |  HTTPS              |  HTTPS              |  HTTPS
           |                     |                     |
           |  UDP (WebRTC media) |  UDP                |  UDP
           |                     |                     |
           v                     v                     v
+----------------------------------------------------------------------+
|                      INFRASTRUCTURE LAYER                            |
|                                                                      |
|  +----------------+   +----------------+   +----------------+        |
|  | Signaling      |   |   Coturn       |   |   mediasoup    |        |
|  | Server         |   |  TURN Server   |   |   SFU Server   |        |
|  | (Node.js +     |   |  (Self-hosted) |   |  (C++ workers  |        |
|  |  Socket.IO)    |   |                |   |   + Node.js)   |        |
|  +-------+--------+   +----------------+   +-------+--------+        |
|          |                                          |                |
|          |  Stores call metadata                    |                |
|          v                                          |                |
|  +----------------+                                 |                |
|  |   MongoDB      |<--------------------------------+                |
|  | (Users, Calls, |   Stores room state,                             |
|  |  Rooms, CDRs)  |   participant info                               |
|  +----------------+                                                  |
|                                                                      |
+----------------------------------------------------------------------+

Components YOU MUST BUILD:
  - Custom signaling protocol (Socket.IO events)
  - SDP/ICE relay logic
  - mediasoup orchestration
  - Coturn deployment + credential rotation
  - Room state management (in MongoDB - NOT recommended)
  - Client SDKs for each platform
  - Recording pipeline
  - Multi-node coordination logic
```

---

## 1.2 Component Architecture (Detailed)

```
+--------------------------------------------------------------------------+
|                     agcloud Backend (Node.js)                             |
|                                                                          |
|  +-------------------+   +-------------------+   +-------------------+   |
|  |   API Layer       |   | Signaling Layer   |   | Media Control     |   |
|  |                   |   |                   |   |                   |   |
|  | - REST API        |   | - Socket.IO       |   | - mediasoup       |   |
|  | - JWT Auth        |   |   server          |   |   Worker mgmt     |   |
|  | - User mgmt       |   | - Custom events   |   | - Router creation |   |
|  | - Call routing    |   |   (call-init,     |   | - Transport setup |   |
|  | - Push notifs     |   |    sdp-offer,     |   | - pipeToRouter    |   |
|  |                   |   |    ice-candidate, |   |   (clustering)    |   |
|  |                   |   |    accept/reject) |   |                   |   |
|  +---------+---------+   +---------+---------+   +---------+---------+   |
|            |                       |                       |             |
|            +-----------+-----------+-----------+-----------+             |
|                        |                       |                         |
|                        v                       v                         |
|  +-------------------------+         +-------------------------+         |
|  |      MongoDB            |         |    mediasoup Workers    |         |
|  |                         |         |                         |         |
|  | - users                 |         | - Worker 1 (CPU core 1) |         |
|  | - calls                 |         | - Worker 2 (CPU core 2) |         |
|  | - rooms                 |         | - Worker N (CPU core N) |         |
|  | - participants          |         |                         |         |
|  | - cdrs                  |         | Each worker hosts:      |         |
|  | - call_history          |         | - Routers               |         |
|  |                         |         | - Transports            |         |
|  | PROBLEM: Can't serve    |         | - Producers             |         |
|  | real-time state at      |         | - Consumers             |         |
|  | scale - need Redis      |         |                         |         |
|  +-------------------------+         +-------------------------+         |
|                                                                          |
+--------------------------------------------------------------------------+
                                     |
                                     | UDP media
                                     v
+--------------------------------------------------------------------------+
|                          Coturn (TURN Server)                            |
|                                                                          |
|  +-------------------+   +-------------------+                           |
|  | STUN responses    |   | TURN relay        |                           |
|  | (find public IP)  |   | (proxy media)     |                           |
|  +-------------------+   +-------------------+                           |
|                                                                          |
|  Used by 15-30% of clients (those behind symmetric NAT/firewalls)       |
|  Requires: Time-limited credentials, bandwidth caps, monitoring          |
+--------------------------------------------------------------------------+
```

---

## 1.3 Call Setup Sequence (1:1) - mediasoup Approach

```
User A (Caller)        Backend             MongoDB         Coturn       mediasoup        User B (Callee)
     |                     |                   |              |              |                  |
     |-- POST /call/init ->|                   |              |              |                  |
     |   (callee: B)       |-- Save call ----->|              |              |                  |
     |                     |<-- Saved ---------|              |              |                  |
     |                     |                   |              |              |                  |
     |                     |-- Push notif ----------------------(via FCM/APNs)----------------->|
     |                     |                   |              |              |                  |
     |<-- Call ID ---------|                   |              |              |                  |
     |                     |                   |              |              |                  |
     |-- Socket.IO conn -->|                   |              |              |                  |
     |   (auth + join)     |                   |              |              |                  |
     |                     |                   |              |              |                  |
     |                     |-- Create router ---------------------------->|  |                  |
     |                     |<------------------- routerId ----------------|  |                  |
     |                     |                   |              |              |                  |
     |                     |-- Create transport ------------------------->|  |                  |
     |                     |<------------------- transport params --------|  |                  |
     |                     |                   |              |              |                  |
     |<-- transport-info --|                   |              |              |                  |
     |                     |                   |              |              |                  |
     |-- Get ICE servers ->|                   |              |              |                  |
     |                     |-- Generate creds -------------->|               |                  |
     |                     |<-- TURN creds ------------------|               |                  |
     |<-- ICE config ------|                   |              |              |                  |
     |                     |                   |              |              |                  |
     |  (User B answers via separate flow, mirrors above)                                       |
     |                     |                   |              |              |                  |
     |-- SDP offer ------->|-- Forward offer -------------------------------------------------->|
     |                     |                   |              |              |                  |
     |<-- SDP answer ------|<-- Forward answer ---------------------------------------|--<------|
     |                     |                   |              |              |                  |
     |-- ICE candidates -->|-- Relay (continuously) ----------------------------------|-------->|
     |<-- ICE candidates --|<-- Relay (continuously) ---------------------------------|---<-----|
     |                     |                   |              |              |                  |
     |-- Connect to mediasoup transport ------------------------------------>|                  |
     |                     |                   |              |<------connect from B ---------- |
     |                     |                   |              |              |                  |
     |== Audio/Video media flows via mediasoup SFU (or P2P/TURN) ===========|                  |
     |                     |                   |              |              |                  |
     |                     |-- Update call status: 'active' ->|              |              |   |
```

**Key issues:**
- **You build everything**: signaling protocol, mediasoup orchestration, ICE config, TURN credentials
- **MongoDB is bottleneck** for real-time state
- **No clustering primitives** - manual pipeToRouter coordination

---

## 1.4 Group Call Architecture (SFU)

```
                          +--------------------------------+
                          |      mediasoup SFU             |
                          |                                |
                          |  +--------------------------+  |
                          |  |        Router            |  |
                          |  |  (one per room)          |  |
                          |  |                          |  |
                          |  |   Producers (incoming)   |  |
                          |  |   Consumers (outgoing)   |  |
                          |  +--------------------------+  |
                          +-+-----+-----+-----+-----+-----+
                            |     |     |     |     |
                ___________/      |     |     |     \___________
               /                  |     |     |                 \
              /                   |     |     |                  \
             v                    v     v     v                   v
      +-----------+        +-----------+    +-----------+    +-----------+
      |  User A   |        |  User B   |    |  User C   |    |  User D   |
      |           |        |           |    |           |    |           |
      | Publishes:|        | Publishes:|    | Publishes:|    | Publishes:|
      |  - Audio  |        |  - Audio  |    |  - Audio  |    |  - Audio  |
      |  - Video  |        |  - Video  |    |  - Video  |    |  - Video  |
      |           |        |           |    |           |    |           |
      | Subscribes|        | Subscribes|    | Subscribes|    | Subscribes|
      | to: B,C,D |        | to: A,C,D |    | to: A,B,D |    | to: A,B,C |
      +-----------+        +-----------+    +-----------+    +-----------+

For 4 participants:
- 4 producers (one per participant)
- 12 consumers (each participant consumes 3 others)
- Total: 16 PeerConnection legs through mediasoup
- Each leg: SDP offer/answer + ICE negotiation handled by YOUR signaling code
- Simulcast must be configured manually
- No automatic dynacast - quality switching is your responsibility
```

---

## 1.5 Scaling Architecture (Production)

```
                         [Cloud Load Balancer]
                                  |
                  +---------------+---------------+
                  |                               |
        [Geographic routing]              [Session affinity]
                  |                               |
+-----------------+-----------------+   +---------+---------+
|                                   |   |                   |
| +---------+  +---------+  +-----+ |   |                   |
| | Node 1  |  | Node 2  |  | N   | |   |                   |
| | (NodeJS |  | (NodeJS |  | ... | |   |                   |
| | + S.IO) |  | + S.IO) |  |     | |   |                   |
| +----+----+  +----+----+  +--+--+ |   |                   |
|      |            |          |    |   |                   |
|      +-----+------+----------+    |   |                   |
|            |                      |   |                   |
|            v                      |   |                   |
|     +---------------+             |   |                   |
|     |  Redis        |             |   |                   |
|     |  (Socket.IO   |             |   |                   |
|     |   adapter)    |             |   |                   |
|     +---------------+             |   |                   |
|                                   |   |                   |
+-----------+-----------------------+   |                   |
            |                           |                   |
            | (route to mediasoup)      | UDP media         |
            v                           v                   v
+-----------------------------------------------------------------+
|                      mediasoup Cluster                          |
|                                                                 |
|  +-------------------+  +-------------------+                   |
|  | mediasoup Node 1  |  | mediasoup Node 2  |                   |
|  | (Region: US)      |  | (Region: EU)      |                   |
|  | - Worker pool     |  | - Worker pool     |                   |
|  | - Routers         |<-| pipeToRouter ---->|                   |
|  | - Transports      |  | - Transports      |                   |
|  +-------------------+  +-------------------+                   |
|                                                                 |
|  YOU BUILD: clustering logic, room-to-node routing,             |
|  failover, load balancing across mediasoup nodes                |
+-----------------------------------------------------------------+
            |
            v
+-----------------------------+        +-----------------------------+
|   MongoDB (replica set)     |        |   Coturn (multi-region)     |
|                             |        |                             |
|  - Persistent data only     |        |  - US TURN cluster          |
|  - Cannot serve real-time   |        |  - EU TURN cluster          |
|    state (Redis needed)     |        |  - APAC TURN cluster        |
+-----------------------------+        +-----------------------------+
```

---

# Approach B: Proposed (LiveKit-based)

## 2.1 High-Level Architecture

```
+----------------------------------------------------------------------+
|                         CLIENT LAYER                                 |
|                                                                      |
|  +----------------+    +----------------+    +----------------+      |
|  |  Web Browser   |    |  Android App   |    |    iOS App     |      |
|  | (LiveKit JS    |    | (LiveKit       |    | (LiveKit       |      |
|  |     SDK)       |    |  Android SDK)  |    |   iOS SDK)     |      |
|  +-------+--------+    +-------+--------+    +-------+--------+      |
|          |                     |                     |               |
+----------|---------------------|---------------------|---------------+
           |                     |                     |
           |  TCP traffic (HTTPS/WSS)                   | UDP (direct)
           |                     |                     |
           v                     v                     |
+----------------------------------------------------+ |
|              EDGE / PROXY LAYER (TCP only)         | |
|                                                    | |
|  +---------------------+    +-------------------+  | |
|  | Cloudflare / WAF    |    | DDoS Protection   |  | |
|  | (optional, public-  |    | Rate limiting     |  | |
|  |  facing edge)       |    | TLS termination   |  | |
|  +----------+----------+    +---------+---------+  | |
|             |                         |            | |
|             +-----------+-------------+            | |
|                         |                          | |
|                         v                          | |
|  +----------------------------------------------+  | |
|  |        Reverse Proxy / Load Balancer         |  | |
|  |    (Nginx / Caddy / Traefik / Cloud LB)      |  | |
|  |                                              |  | |
|  |  - TLS termination (Let's Encrypt / ACM)     |  | |
|  |  - WebSocket upgrade (HTTP -> WSS)           |  | |
|  |  - Path-based routing:                       |  | |
|  |      /api/*  -> Node.js Backend              |  | |
|  |      /rtc    -> LiveKit Signaling (WSS)      |  | |
|  |  - Health checks                             |  | |
|  |  - Sticky sessions for WebSockets            |  | |
|  +-------+----------------------------+---------+  | |
|          |                            |            | |
+----------|----------------------------|------------+ |
           |                            |              |
           v                            v              v
+----------------------------------------------------------------------+
|                      INFRASTRUCTURE LAYER                            |
|                                                                      |
|  +-------------------+        +-------------------+                  |
|  | Node.js Backend   |        |  LiveKit Server   |<-- UDP media -- |
|  | (Business logic)  |        |  (All-in-one)     |    (bypasses    |
|  |                   | Twirp  |                   |    proxy)       |
|  | - Auth            |<------>| - Signaling (WS)  |                  |
|  | - Call init       |  API   | - SFU (Go)        |                  |
|  | - Push notifs     |        | - TURN (embedded) |                  |
|  | - Token gen       |Webhooks| - Recording       |                  |
|  | - Call history    |<-------|   (Egress)        |                  |
|  | - User mgmt       |        |                   |                  |
|  +---------+---------+        +---------+---------+                  |
|            |                            |                            |
|            v                            v                            |
|  +----------------+         +----------------+                       |
|  |    MongoDB     |         |    Redis       |                       |
|  | (persistent)   |         | (real-time)    |                       |
|  |                |         |                |                       |
|  | - users        |         | - presence     |                       |
|  | - calls        |         | - room state   |                       |
|  | - call_history |         | - LiveKit      |                       |
|  | - subscriptions|         |   coordination |                       |
|  +----------------+         +----------------+                       |
|                                                                      |
+----------------------------------------------------------------------+

CRITICAL RULE:
  - TCP traffic (HTTPS/WSS) goes THROUGH the proxy
  - UDP media (WebRTC RTP/RTCP) goes DIRECTLY to LiveKit
  - Proxying UDP would add unacceptable latency to media

Components LIVEKIT PROVIDES (you DON'T build):
  - Signaling protocol (WebSocket + Protobuf)
  - SDP/ICE handling
  - SFU media routing
  - TURN relay (embedded)
  - Simulcast + adaptive bitrate (dynacast)
  - Recording (Egress)
  - Client SDKs (JS, Android, iOS, Flutter, etc.)
  - Multi-node clustering (via Redis)
  - Token-based authentication
```

---

## 2.2 Component Architecture (Detailed)

```
+--------------------------------------------------------------------------+
|                     agcloud Backend (Node.js)                             |
|                  (Modular monolith - your code)                          |
|                                                                          |
|  +-------------------+   +-------------------+   +-------------------+   |
|  |   Auth Module     |   |  Call Module      |   | LiveKit Module    |   |
|  |                   |   |                   |   |                   |   |
|  | - JWT generation  |   | - Call initiation |   | - Token gen       |   |
|  | - User signup/in  |   | - Ring/Accept/    |   |   (AccessToken)   |   |
|  | - OAuth (optional)|   |   Reject logic    |   | - RoomServiceCli  |   |
|  | - Permissions     |   | - Push notifs     |   | - EgressClient    |   |
|  |                   |   | - Call states     |   | - WebhookReceiver |   |
|  +---------+---------+   +---------+---------+   +---------+---------+   |
|            |                       |                       |             |
|            +-----------+-----------+-----------+-----------+             |
|                        |                       |                         |
|            v           v                       v                         |
|  +-------------------------+         +-------------------------+         |
|  |       MongoDB           |         |        Redis            |         |
|  |   (persistent data)     |         |    (real-time state)    |         |
|  |                         |         |                         |         |
|  | - users (collection)    |         | - presence (online/off) |         |
|  | - call_history          |         | - active calls          |         |
|  | - cdrs                  |         | - pub/sub for backend   |         |
|  | - subscriptions         |         |   horizontal scaling    |         |
|  | - rooms config          |         | - rate limiting         |         |
|  +-------------------------+         +-------------------------+         |
|                                                                          |
+--------------------------------------------------------------------------+
              |                                          ^
              | Twirp API (HTTP+protobuf)                | Webhooks (HTTP)
              | - Create rooms                           | - participant_joined
              | - List participants                      | - participant_left
              | - Generate tokens (server-side)          | - room_finished
              | - Start/stop egress                      | - track_published
              v                                          |
+--------------------------------------------------------------------------+
|                      LiveKit Server (Go-based)                           |
|                                                                          |
|  +-------------------+   +-------------------+   +-------------------+   |
|  | Signaling Layer   |   |    SFU Layer      |   | TURN Server       |   |
|  | (WebSocket +      |   |  (Media routing)  |   | (Embedded Pion)   |   |
|  |   Protobuf)       |   |                   |   |                   |   |
|  | - Room mgmt       |   | - Track forward   |   | - Port 443/TLS    |   |
|  | - SDP exchange    |   | - Simulcast       |   |   (firewall fix)  |   |
|  | - ICE candidates  |   | - Dynacast        |   | - Time-limited    |   |
|  | - Participant     |   | - Adaptive bitrate|   |   credentials     |   |
|  |   lifecycle       |   | - DTLS/SRTP       |   |                   |   |
|  +---------+---------+   +---------+---------+   +-------------------+   |
|            |                       |                                     |
|            +---------+-------------+                                     |
|                      v                                                   |
|  +-------------------------+                                             |
|  | Egress Service          |                                             |
|  |                         |                                             |
|  | - Room recording        |                                             |
|  | - RTMP streaming        |                                             |
|  | - Composite layouts     |                                             |
|  | - S3 upload             |                                             |
|  +-------------------------+                                             |
|                                                                          |
+--------------------------------------------------------------------------+
                     |
                     | (Multi-node coordination)
                     v
              [Redis (shared)]
```

---

## 2.3 Call Setup Sequence (1:1) - LiveKit Approach

```
User A (Caller)        Backend             MongoDB         Redis        LiveKit         User B (Callee)
     |                     |                   |              |              |                  |
     |-- POST /call/init ->|                   |              |              |                  |
     |   (callee: B)       |                   |              |              |                  |
     |                     |-- Insert doc ---->|              |              |                  |
     |                     |<-- Saved ---------|              |              |                  |
     |                     |                   |              |              |                  |
     |                     |-- Twirp: createRoom ----------------------------->|                |
     |                     |<-- Room created -------------------------|        |                |
     |                     |                   |              |              |                  |
     |                     |-- Generate token A (signed JWT)               |  |                |
     |                     |-- Generate token B (signed JWT)               |  |                |
     |                     |                   |              |              |                  |
     |                     |-- SET call:state ------------>|                  |                  |
     |                     |   (state: ringing)            |                  |                  |
     |                     |                   |              |              |                  |
     |                     |-- Push notif (FCM/APNs) ----------------------------------------->|
     |                     |   (call ID + room name)       |                  |                  |
     |                     |                   |              |              |                  |
     |<-- Token A + URL ---|                   |              |              |                  |
     |                     |                   |              |              |                  |
     |-- room.connect(url, token A) -->|       |              |              |                  |
     |                     |                   |              |              |                  |
     |== WebSocket /rtc?access_token=tokenA =================================>|                  |
     |                     |                   |              |              |                  |
     |<====== JoinResponse (room state + SDP offer for subscriber) ===========|                  |
     |                     |                   |              |              |                  |
     |== SDP answer + ICE candidates =========================================>|                  |
     |                     |                   |              |              |                  |
     |                     |<-- Webhook: participant_joined ------------------|                  |
     |                     |-- updateOne: 'connecting' --->|                 |                  |
     |                     |                   |              |              |                  |
     |                     |                   |              |              |                  |
     |                     |                   |  (User B accepts call)      |                  |
     |                     |<-- POST /call/accept -----------------------------------------------|
     |                     |                   |              |              |                  |
     |<-- Token B ---------|                                  |              |                  |
     |                     |--------------------------------------------------------------------- ->|
     |                     |                                                                   |
     |                     |                                          User B: room.connect()      |
     |                     |                                          == WebSocket =========> |
     |                     |                                                                  |
     |                     |<-- Webhook: participant_joined (B) ------------|                  |
     |                     |-- updateOne: 'active' ------->|                |                  |
     |                     |                   |              |              |                  |
     |== Audio/Video media flows directly through LiveKit SFU ===============================>|
     |                     |                   |              |              |                  |
     |                     |                   |              |              |                  |
     |                     |  (Either party hangs up)                       |                  |
     |                     |<-- Webhook: room_finished ----------------------|                  |
     |                     |-- updateOne: 'ended' -------->|                |                  |
     |                     |   + duration calculated       |                |                  |
```

**Key advantages:**
- **LiveKit handles everything WebRTC**: SDP, ICE, TURN, simulcast, recording
- **Your backend only handles business logic**: call states, push notifications, history
- **Webhooks notify you of all events** - no polling, no custom signaling
- **Token-based auth** - cryptographically secure, time-limited

---

## 2.4 Group Call Architecture - LiveKit

```
                          +--------------------------------+
                          |      LiveKit SFU (Go)          |
                          |                                |
                          |  +--------------------------+  |
                          |  |  Room: call-room-123     |  |
                          |  |                          |  |
                          |  |  Auto-managed:           |  |
                          |  |   - Simulcast layers     |  |
                          |  |   - Dynacast (auto       |  |
                          |  |     subscribe quality)   |  |
                          |  |   - Adaptive bitrate     |  |
                          |  |   - Connection quality   |  |
                          |  +--------------------------+  |
                          +-+-----+-----+-----+-----+-----+
                            |     |     |     |     |
                ___________/      |     |     |     \___________
               /                  |     |     |                 \
              /                   |     |     |                  \
             v                    v     v     v                   v
      +-----------+        +-----------+    +-----------+    +-----------+
      |  User A   |        |  User B   |    |  User C   |    |  User D   |
      |           |        |           |    |           |    |           |
      | Publisher |        | Publisher |    | Publisher |    | Publisher |
      | PC: 1     |        | PC: 1     |    | PC: 1     |    | PC: 1     |
      |           |        |           |    |           |    |           |
      | Subscriber|        | Subscriber|    | Subscriber|    | Subscriber|
      | PC: 1     |        | PC: 1     |    | PC: 1     |    | PC: 1     |
      |           |        |           |    |           |    |           |
      | (Receives |        | (Receives |    | (Receives |    | (Receives |
      |  all      |        |  all      |    |  all      |    |  all      |
      |  others)  |        |  others)  |    |  others)  |    |  others)  |
      +-----------+        +-----------+    +-----------+    +-----------+

For 4 participants:
- Each user has only 2 PeerConnections (1 publisher, 1 subscriber)
- Total: 8 PeerConnections across all users (vs 16 with naive mediasoup)
- Simulcast configured automatically (3 quality layers)
- Dynacast: SFU only forwards what each subscriber actually needs
- Adaptive bitrate: automatic based on network conditions
- Speaker detection built-in
```

---

## 2.5 Proxy / Load Balancer Layer (Detailed)

This is the critical edge layer between clients and the application infrastructure. It handles TCP traffic only — UDP media bypasses it entirely.

### 2.5.1 Traffic Flow Through the Proxy

```
                               Client
                                 |
       +-------------------------+-------------------------+
       |                         |                         |
       v                         v                         v
   HTTPS (TCP)              WSS (TCP)                  UDP (RTP)
   /api/*                   /rtc                       Port 7881
                                                       50000-60000
       |                         |                         |
       v                         v                         |
+--------------------------------------------------------+ |
|              Proxy / Load Balancer                     | |
|                                                        | |
|  Routes:                                               | |
|    /api/auth/*    -->  Node.js Backend (port 3000)    | |
|    /api/calls/*   -->  Node.js Backend                | |
|    /api/users/*   -->  Node.js Backend                | |
|    /livekit-webhook -> Node.js Backend                | |
|                                                        | |
|    /rtc           -->  LiveKit Server (port 7880)     | |
|    /              -->  LiveKit (HTTP API)             | |
|                                                        | |
|  Features:                                             | |
|    - TLS termination (port 443)                        | |
|    - WebSocket upgrade (Connection: upgrade)           | |
|    - Sticky sessions (WSS connections)                 | |
|    - Health checks (every 5s)                          | |
|    - Rate limiting (per IP, per route)                 | |
|    - Compression (gzip/brotli for HTTP)                | |
|    - Access logging                                    | |
+----+--------------------------------+------------------+ |
     |                                |                    |
     v                                v                    v
+----------------+              +-----------------+   +-----------------+
| Node.js        |              | LiveKit Server  |   | LiveKit Server  |
| Backend        |              | (Signaling/WSS) |   | (UDP media)     |
| Port 3000      |              | Port 7880       |   | Port 7881       |
+----------------+              +-----------------+   | + 50000-60000   |
                                                      +-----------------+
                                                      DIRECT (no proxy)
```

### 2.5.2 Proxy Choices by Deployment Stage

| Stage | Recommended Proxy | Why |
|-------|------------------|-----|
| **MVP / Development** | **Caddy** | Auto-TLS via Let's Encrypt, simplest config, single binary |
| **Single-region production** | **Nginx** or **Caddy** | Mature, well-documented, battle-tested |
| **Multi-region production** | **Cloud LB** (AWS ALB / GCP LB) **+ Nginx** | Geo-routing, managed TLS, DDoS protection |
| **Kubernetes** | **Traefik** or **Nginx Ingress** | Container-aware, auto-discovery, integrates with K8s |
| **Public-facing at scale** | **Cloudflare** + Nginx/Caddy | WAF, DDoS, global CDN, edge caching |

### 2.5.3 MVP Configuration: Caddy (Recommended)

Caddy auto-provisions TLS certificates and has the simplest configuration:

```caddy
# Caddyfile

# Backend API
api.agcloud.example.com {
    reverse_proxy node-backend:3000

    # Webhook endpoint from LiveKit
    handle /livekit-webhook {
        reverse_proxy node-backend:3000
    }

    # Rate limiting
    rate_limit {
        zone api {
            key {http.request.remote_host}
            events 100
            window 1m
        }
    }
}

# LiveKit Signaling
livekit.agcloud.example.com {
    reverse_proxy livekit-server:7880 {
        # WebSocket upgrade headers
        header_up Connection {>Connection}
        header_up Upgrade {>Upgrade}

        # Long-lived WSS connections
        transport http {
            read_timeout 24h
            write_timeout 24h
        }
    }
}
```

### 2.5.4 Production Configuration: Nginx

```nginx
# /etc/nginx/sites-enabled/agcloud.conf

# Upstream definitions
upstream node_backend {
    least_conn;
    server backend1:3000 max_fails=3 fail_timeout=30s;
    server backend2:3000 max_fails=3 fail_timeout=30s;
    server backend3:3000 max_fails=3 fail_timeout=30s;
}

upstream livekit_signaling {
    ip_hash;  # Sticky sessions for WebSocket
    server livekit1:7880 max_fails=3 fail_timeout=30s;
    server livekit2:7880 max_fails=3 fail_timeout=30s;
}

# Rate limiting zones
limit_req_zone $binary_remote_addr zone=api:10m rate=100r/m;
limit_req_zone $binary_remote_addr zone=auth:10m rate=10r/m;

# Backend API server
server {
    listen 443 ssl http2;
    server_name api.agcloud.example.com;

    # TLS configuration
    ssl_certificate /etc/letsencrypt/live/api.agcloud.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.agcloud.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;

    # Auth endpoints - stricter rate limit
    location /api/auth/ {
        limit_req zone=auth burst=5 nodelay;
        proxy_pass http://node_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # General API endpoints
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://node_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # LiveKit webhook (from LiveKit -> backend)
    location /livekit-webhook {
        proxy_pass http://node_backend;
        proxy_set_header Host $host;
    }

    # Health check
    location /health {
        proxy_pass http://node_backend;
        access_log off;
    }
}

# LiveKit signaling server
server {
    listen 443 ssl http2;
    server_name livekit.agcloud.example.com;

    ssl_certificate /etc/letsencrypt/live/livekit.agcloud.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/livekit.agcloud.example.com/privkey.pem;

    # WebSocket signaling
    location / {
        proxy_pass http://livekit_signaling;
        proxy_http_version 1.1;

        # WebSocket upgrade headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Long-lived WebSocket connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_connect_timeout 60s;

        # Disable buffering for real-time signaling
        proxy_buffering off;
    }
}

# Redirect HTTP -> HTTPS
server {
    listen 80;
    server_name api.agcloud.example.com livekit.agcloud.example.com;
    return 301 https://$server_name$request_uri;
}
```

### 2.5.5 Critical: UDP Ports Bypass the Proxy

**UDP media traffic must NOT be proxied.** Configure firewall/security group to allow direct access to LiveKit:

| Port | Protocol | Source | Destination | Why |
|------|----------|--------|-------------|-----|
| 443 | TCP | Internet | Proxy | HTTPS API + WSS signaling |
| 80 | TCP | Internet | Proxy | HTTP -> HTTPS redirect |
| 7881 | UDP | Internet | LiveKit Server | WebRTC media (primary) |
| 50000-60000 | UDP | Internet | LiveKit Server | WebRTC media (range) |
| 443 | TCP | Internet | LiveKit Server | TURN over TLS (firewall fallback) |
| 3478 | UDP | Internet | LiveKit Server | TURN UDP (optional) |
| 3000 | TCP | Proxy only | Node.js Backend | Backend (internal) |
| 7880 | TCP | Proxy only | LiveKit Server | Signaling (internal) |

```
Firewall / Security Group Rules:
+---------------+---------------+---------------+----------------------+
| Port          | Protocol      | Source        | Target               |
+---------------+---------------+---------------+----------------------+
| 443           | TCP           | 0.0.0.0/0     | Proxy                |
| 80            | TCP           | 0.0.0.0/0     | Proxy                |
| 7881          | UDP           | 0.0.0.0/0     | LiveKit (DIRECT)     |
| 50000-60000   | UDP           | 0.0.0.0/0     | LiveKit (DIRECT)     |
| 443           | TCP           | 0.0.0.0/0     | LiveKit (TURN/TLS)   |
| 3000          | TCP           | Proxy only    | Backend              |
| 7880          | TCP           | Proxy only    | LiveKit              |
| 27017         | TCP           | Backend only  | MongoDB              |
| 6379          | TCP           | Backend, LK   | Redis                |
+---------------+---------------+---------------+----------------------+
```

### 2.5.6 Cloud Load Balancer (AWS Example)

For production at scale, a managed cloud load balancer adds geo-routing, DDoS protection, and managed TLS:

```
                        [Cloudflare]
                        - WAF rules
                        - DDoS shield
                        - Global CDN
                              |
                              v
                    [AWS Application LB (ALB)]
                    - Geographic routing
                    - Health checks
                    - ACM certificates (managed TLS)
                    - HTTP/2 + WebSocket support
                    - Sticky sessions
                              |
              +---------------+---------------+
              |                               |
      +-------v-------+               +-------v-------+
      |  Target Group |               |  Target Group |
      |  (Backend)    |               |  (LiveKit WS) |
      |               |               |               |
      | Health: /health|              | Health: /     |
      | Port: 3000    |               | Port: 7880    |
      +-------+-------+               +-------+-------+
              |                               |
   +----------+----------+         +---------+---------+
   |          |          |         |         |         |
+--v--+   +--v--+   +--v--+   +---v--+  +--v---+  +--v---+
| EC2 |   | EC2 |   | EC2 |   | EC2  |  | EC2  |  | EC2  |
|Back |   |Back |   |Back |   |LiveK |  |LiveK |  |LiveK |
+-----+   +-----+   +-----+   +--+---+  +--+---+  +--+---+
                                  |        |          |
                                  v        v          v
                              UDP traffic via NLB or hostNetwork
                              (separate from ALB)
```

### 2.5.7 Why You Need a Proxy (Not Just Direct Exposure)

| Without Proxy | With Proxy |
|---------------|-----------|
| Each service manages own TLS certs | Single point for cert management |
| LiveKit + Backend each need public IPs | Single public IP |
| No request logging across services | Centralized access logs |
| No rate limiting | Per-route rate limits |
| No DDoS protection | WAF + rate limiting |
| Hard to do canary/blue-green | Easy traffic shifting |
| Each service exposed = larger attack surface | Backend not directly exposed |

### 2.5.8 Common Pitfalls

| Pitfall | Why It Breaks | Fix |
|---------|--------------|-----|
| Proxying UDP media | Adds 50-200ms latency, breaks WebRTC | Never proxy UDP — direct to LiveKit |
| Short proxy timeouts | WebSocket disconnects every N seconds | Set `proxy_read_timeout 86400s` |
| Missing WebSocket headers | LiveKit signaling fails | Set `Upgrade` and `Connection` headers |
| Buffering enabled for WSS | Adds latency to signaling | `proxy_buffering off` for /rtc |
| No sticky sessions | Multi-node WebSockets break | Use `ip_hash` or `least_conn` with cookies |
| Health check on `/` of LiveKit | Returns WebSocket upgrade required | Use `/` with `Upgrade` header or dedicated health endpoint |
| Single AZ deployment | LB failure = total outage | Multi-AZ with cross-zone load balancing |

---

## 2.6 Scaling Architecture (Production - LiveKit)

```
                              Internet
                                 |
                    +------------+------------+
                    |            |            |
                    v            v            v
                  TCP          TCP          UDP (direct - no proxy)
                  HTTPS        WSS          7881, 50000-60000
                    |            |            |
                    v            v            |
+------------------------------------+        |
|         Cloudflare (Edge)          |        |
|  - WAF / DDoS protection           |        |
|  - Global CDN                      |        |
|  - Bot management                  |        |
+------------------+-----------------+        |
                   |                          |
                   v                          |
+------------------------------------+        |
|     Cloud Load Balancer            |        |
|     (AWS ALB / GCP LB / Azure LB)  |        |
|  - Geo-routing (closest region)    |        |
|  - Managed TLS (ACM)               |        |
|  - Health checks                   |        |
|  - Sticky sessions for WebSockets  |        |
+--+--------------------+------------+        |
   |                    |                     |
   | /api/*             | /rtc                |
   v                    v                     |
+------------------+  +------------------+    |
| Backend Target   |  | LiveKit Target   |    |
| Group            |  | Group (WSS only) |    |
+--+---------------+  +---------+--------+    |
   |                            |              |
   |  +---------+  +---------+  |  +-----+ +-----+ +-----+
   |  | Node 1  |  | Node 2  |  |  | LK1 | | LK2 | | LK3 |<-----+
   |  | (NodeJS |  | (NodeJS |  |  |(US) | |(EU) | |(APC)|      |
   |  |  API)   |  |  API)   |  |  +--+--+ +--+--+ +--+--+      |
   |  +----+----+  +----+----+  |     |       |       |          |
   +-------+------------+-------+     |       |       |          |
           |            |             +-------+-------+          |
           v            v                     |                  |
   +---------------------+              +-----------+            |
   |     MongoDB        |               |  Redis    |<-----------+
   |   (Replica Set:    |               |  Cluster  |
   |    Primary +       |               |           |
   |    Secondaries)    |               | LiveKit   |
   |   - Multi-AZ       |               | uses for: |
   +---------------------+              | - Room    |
                                        |   routing |
                                        | - Node    |
                                        |   discovery
                                        +-----------+
                                              |
                                              v
                                      +----------------+
                                      | S3 / Object    |
                                      | Storage        |
                                      | (recordings)   |
                                      +----------------+

KEY POINTS:
- TCP traffic: Cloudflare -> Cloud LB -> Backend or LiveKit (signaling)
- UDP traffic: Direct from Internet to LiveKit (bypasses ALL proxies)
- Multi-region LiveKit nodes coordinate via shared Redis cluster
- New LiveKit node? Just point it at Redis. Auto-discovery.
```

### 2.6.1 Why UDP Goes Direct (Not Through LB)

Most cloud load balancers (AWS ALB, GCP HTTPS LB, Azure App Gateway) are **Layer 7 (HTTP/HTTPS)** and do NOT support UDP. Even Layer 4 LBs (NLB) add latency that hurts WebRTC quality.

**Solution patterns:**

| Pattern | How |
|---------|-----|
| **Public IP per LiveKit node** | Each node has elastic IP, advertised via STUN; clients connect directly |
| **NLB for UDP** (AWS) | Network Load Balancer with UDP listener — adds slight latency but enables HA |
| **hostNetwork in K8s** | Pods bind directly to node's network — bypasses cluster networking |
| **DaemonSet + NodePort** | Run LiveKit on every node, advertise node IPs |

The standard recommendation: **Public IPs on LiveKit nodes + STUN-advertised candidates**. The TCP signaling layer can be load-balanced normally; clients learn LiveKit's actual IP via signaling and send UDP directly.

---

# Side-by-Side Comparison

## Component Count

```
APPROACH A (mediasoup):                APPROACH B (LiveKit):
                                       
+-------------------+                  +-------------------+
| Node.js Backend   |                  | Node.js Backend   |
+-------------------+                  +-------------------+
| Socket.IO Server  |   ALL OF         | LiveKit Server    |
+-------------------+   THESE          | (replaces 3 boxes |
| mediasoup SFU     |   REPLACED  ==>  |  on the left)     |
+-------------------+   BY ONE         +-------------------+
| Coturn TURN       |                  |     MongoDB       |
+-------------------+                  +-------------------+
| MongoDB           |                  | Redis             |
+-------------------+                  +-------------------+
                                       
5 components to                        3 components to
deploy + maintain                      deploy + maintain
                                       
+ build all client                     + Use official SDKs
  SDKs from scratch                    
+ build clustering                     + Built-in clustering
  logic                                
+ build recording                      + Built-in recording
  pipeline                             
+ build observability                  + Built-in metrics
```

## Code You Write

```
APPROACH A (mediasoup):                  APPROACH B (LiveKit):

+-----------------------------+          +-----------------------------+
| Custom signaling protocol   |          | Call initiation logic       |
| SDP/ICE relay logic         |          | (ring/accept/reject)        |
| mediasoup orchestration     |          |                             |
| Worker management           |          | Push notifications          |
| Room state management       |          |                             |
| Coturn credential rotation  |          | Token generation            |
| Custom client SDKs (3x)     |          | (using LiveKit SDK)         |
| Recording pipeline          |          |                             |
| Multi-node clustering       |          | Webhook handling            |
| Observability/metrics       |          |                             |
| Simulcast configuration     |          | Business logic + UI         |
| Adaptive bitrate            |          |                             |
| Reconnection logic          |          |                             |
| Network switching handling  |          |                             |
+-----------------------------+          +-----------------------------+
        ~14-16 weeks                              ~4-6 weeks
```

## Network Flow Comparison

```
APPROACH A: Client connects to multiple endpoints
                                                                  
  Client                                                          
    |                                                             
    +---- WSS (Socket.IO)  -----> Your Signaling Server          
    |                                                             
    +---- HTTPS (REST API) -----> Your Backend                   
    |                                                             
    +---- UDP (WebRTC)     -----> mediasoup Server               
    |                                                             
    +---- UDP/TCP (TURN)   -----> Coturn (separate fleet)        


APPROACH B: Client connects to LiveKit + Backend only

  Client                                                          
    |                                                             
    +---- HTTPS (REST API) -----> Your Backend (token gen)       
    |                                                             
    +---- WSS (LiveKit)    -----> LiveKit Server                 
    |                                                             
    +---- UDP (WebRTC)     -----> LiveKit Server (same host)     
    |                                                             
    +---- UDP/TCP/TLS 443  -----> LiveKit Server (embedded TURN) 
```

## Operational Complexity

| Aspect | Approach A (mediasoup) | Approach B (LiveKit) |
|--------|------------------------|----------------------|
| **Number of services** | 5 (Node.js, Socket.IO, mediasoup, Coturn, MongoDB) | 3 (Node.js, LiveKit, MongoDB+Redis) |
| **Different processes** | 4 distinct technologies | 2 distinct technologies |
| **Languages to maintain** | JavaScript, C++, C | JavaScript, Go (LiveKit team maintains) |
| **Configuration files** | Many - per service | One livekit.yaml + your app config |
| **Monitoring endpoints** | One per service | LiveKit has built-in Prometheus metrics |
| **Update/upgrade cadence** | Coordinate 4 different release cycles | LiveKit single binary upgrade |
| **Multi-region setup** | Manual TURN deployment per region + custom routing | Just add LiveKit nodes + Redis |
| **Recording** | Build entire pipeline | Single API call |
| **Client SDK updates** | You maintain SDKs | LiveKit team maintains SDKs |

## Time-to-MVP Comparison

```
                     Weeks 1-4     Weeks 5-8     Weeks 9-12    Weeks 13-16
                     ----------    ----------    ----------    -----------

APPROACH A:          [Signaling]   [TURN +       [SFU +        [Polish +
(mediasoup)          [server]      [Coturn]      [recording]   [iOS fixes]
                                                 [+clustering]
                                                 
                     |---WIRE BASIC P2P--|       |--SFU GROUP CALLS--|
                     |
                     v
                     ~~~~~ MVP at week 14-16 ~~~~~


APPROACH B:          [Setup +      [Group calls  [Recording +  ===========
(LiveKit)            [1:1 calls]   [+features]   [push notifs]
                                   
                     |--MVP READY!--|
                     |
                     v
                     ~~~~~ MVP at week 5-6 ~~~~~

Time saved: ~10 weeks (>2x faster)
```

---

## Bottom Line

| Question | Approach A (mediasoup) | Approach B (LiveKit) |
|----------|------------------------|----------------------|
| Is it feasible? | Yes, but complex | Yes, much simpler |
| Time to MVP | 14-16 weeks | 4-6 weeks |
| Components to maintain | 5 | 3 |
| Built-in clustering | No | Yes |
| Official SDKs | No | Yes (8 platforms) |
| Recording | Build yourself | Built-in |
| Maintainer team | 2-3 devs (volunteer) | VC-funded company |
| Best for | Maximum control, learning | Production speed, reliability |

**Recommendation: Approach B (LiveKit)** for any goal except deep WebRTC learning or extreme customization needs.
