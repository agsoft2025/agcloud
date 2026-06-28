# agcloud: Complete Feasibility Research & Technical Analysis

> **Date:** 2026-04-14
> **Scope:** Deep research into building a ZEGOCLOUD/Twilio-like video calling platform
> **Proposed Stack:** Node.js + MongoDB + Socket.IO + WebRTC + Coturn + mediasoup

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Feasibility Analysis](#2-feasibility-analysis)
3. [Component-by-Component Assessment](#3-component-by-component-assessment)
4. [Technical Risk Analysis](#4-technical-risk-analysis)
5. [Cost Analysis](#5-cost-analysis)
6. [Alternative Stack Recommendation](#6-alternative-stack-recommendation)
7. [Architecture Suggestions](#7-architecture-suggestions)
8. [Open-Source Projects to Study](#8-open-source-projects-to-study)
9. [Smart MVP Strategy](#9-smart-mvp-strategy)
10. [Build vs Buy Analysis](#10-build-vs-buy-analysis)
11. [Sources & References](#11-sources--references)

---

## 1. Executive Summary

**Verdict: Feasible, but the proposed stack has significant risks that can be mitigated with better component choices.**

WebRTC is proven and mature — it powers Google Meet, Discord, Slack Huddles, and thousands of production apps. The core concept is sound. However, the specific combination of Socket.IO + mediasoup + Coturn + MongoDB carries unnecessary risk compared to modern alternatives.

**Key findings:**
- The proposed stack **works** but requires ~3-4 months to reach a working MVP
- **LiveKit** (open-source, self-hostable) replaces three components (signaling + SFU + TURN) in one package, cutting MVP time to ~4-6 weeks
- **Redis is mandatory** — MongoDB alone cannot serve real-time call state
- **Bandwidth is the #1 cost** — not compute, not storage
- The build-vs-buy breakeven is ~50K-100K concurrent users
- **iOS/Safari is the biggest cross-platform pain point**, not Android

---

## 2. Feasibility Analysis

### 2.1 WebRTC in Production (2025-2026)

WebRTC is the **only viable standard** for real-time browser-based audio/video. It is an IETF/W3C standard supported natively in all major browsers.

**Browser Support Status:**

| Browser | Support Level | Notes |
|---------|--------------|-------|
| Chrome (Desktop/Android) | Excellent | Full VP8/VP9/H.264, simulcast, Insertable Streams |
| Firefox | Excellent | Full support, minor simulcast differences from Chrome |
| Edge | Excellent | Chromium-based, identical to Chrome |
| Safari (macOS) | Good | H.264-only preferred, limited VP9, some API gaps |
| Safari (iOS) | Problematic | ALL iOS browsers use WebKit — H.264 only, no Insertable Streams, limited simulcast/SVC, drops connections when backgrounded >30 seconds |
| Android WebView | Unreliable | Does not reliably support WebRTC — must use Chrome Custom Tabs or native SDK |

**NAT Traversal Reality:**
- **15-30% of connections require TURN relay** in real-world deployments
- Symmetric NATs and CGNAT (Carrier-Grade NAT) are increasingly common — this percentage is trending **upward**
- Corporate firewalls and VPNs frequently block UDP entirely, forcing TURN/TCP fallback
- In enterprise environments (offices, hospitals, schools), TURN usage can reach **40-50%**

**Conclusion:** WebRTC is the right technology. Budget significant engineering time for Safari/iOS quirks and TURN infrastructure.

### 2.2 Latency Expectations

| Network Condition | Glass-to-Glass Latency | Acceptable? |
|-------------------|----------------------|-------------|
| Wired LAN | 50-150ms | Excellent |
| Wired Internet | 200-300ms | Good |
| Wi-Fi | 250-400ms | Acceptable |
| 4G/LTE | 400-600ms | Borderline |
| 5G | 250-400ms | Good |
| TURN-relayed | +50-100ms overhead | Acceptable |
| SFU (mediasoup) | +10-50ms overhead | Negligible |

**ITU-T G.114 standard:** Latency must stay under **400ms** for interactive conversation. Users perceive degradation above 400-500ms.

**Key factor:** Geographic distance between users and the nearest SFU/TURN server matters most. Multi-region deployment is critical for global service.

### 2.3 Scale Numbers (mediasoup)

| Metric | Value |
|--------|-------|
| Consumers per CPU core | ~500 |
| 4-person rooms per core | ~20 |
| 4-person rooms on 16-core server | ~320 |
| Horizontal scaling method | `pipeToRouter()` across workers/hosts |
| Built-in clustering | None — must build yourself |

---

## 3. Component-by-Component Assessment

### 3.1 Node.js + Socket.IO (Signaling Server)

**Role:** Exchanges SDP offers/answers and ICE candidates between peers. Does NOT carry media.

**Assessment: Adequate for MVP, but Socket.IO has scaling limitations.**

| Aspect | Detail |
|--------|--------|
| Concurrency (Socket.IO) | ~10-55K connections per process (OS-tunable) |
| Concurrency (raw WebSocket) | ~50K+ connections per process |
| Horizontal scaling | Via `@socket.io/redis-adapter` or `@socket.io/cluster-adapter` |
| vs Go | Go achieves ~2.5x throughput under sustained WebSocket load |
| vs Elixir | Elixir achieves ~2.6x throughput under sustained WebSocket load |
| Bottleneck risk | Low — signaling is lightweight; media routing is the real bottleneck |

**Risks:**
- Socket.IO adds ~30KB bundle weight and protocol overhead (polling fallback, heartbeat)
- Most production platforms migrate to raw WebSockets or gRPC for signaling
- Socket.IO caps at ~10K connections/process due to heartbeat + polling fallback overhead

**Recommendation:** Use **raw WebSockets** instead of Socket.IO. All modern browsers support WebSockets natively. Socket.IO's polling fallback is unnecessary in 2025-2026. For horizontal scaling, use **Redis Pub/Sub** behind WebSocket servers.

### 3.2 mediasoup (SFU - Selective Forwarding Unit)

**Role:** Routes media streams between participants without encoding/decoding. Essential for group calls (3+ participants).

**Assessment: Production-ready and performant, but carries dependency risk.**

| Aspect | Detail |
|--------|--------|
| Architecture | C++ media workers + Node.js orchestration layer |
| Performance | Best-in-class for Node.js ecosystem |
| Adopters | 38+ companies tracked by TheirStack; OpenVidu uses mediasoup engine |
| Maintainers | **2-3 developers** — no commercial entity backing |
| GitHub Stars | ~6K |
| Clustering | **None built-in** — must implement yourself via `pipeToRouter()` |
| Simulcast | Supported |
| Recording | Must implement yourself |
| SDKs | Must build yourself |

**Comparison with alternatives:**

| Feature | mediasoup | Janus Gateway | Jitsi Videobridge | LiveKit |
|---------|-----------|---------------|-------------------|---------|
| Language | C++ + Node.js | C | Java | Go |
| Focus | Library (build your own) | Plugin-based server | Full product (with UI) | Full infrastructure |
| Performance | Excellent | Good | Good | Excellent |
| Clustering | Manual | Manual | Built-in | Built-in |
| SIP/RTSP | No | Yes | No | Via Ingress |
| Recording | No | Plugin | Built-in | Built-in (Egress) |
| SDKs | None | None | JS, Android, iOS | JS, React, Android, iOS, Flutter, Unity, Rust |
| Maintainer risk | HIGH (2-3 people) | Medium (Meetecho) | Low (8x8) | Low (VC-funded company) |
| GitHub Stars | ~6K | ~8K | ~3K | ~22K+ |

**Conclusion:** mediasoup is technically excellent but carries significant bus-factor risk. LiveKit provides equivalent or better functionality with much lower risk.

### 3.3 Coturn (TURN Server)

**Role:** Relays media when direct P2P connection fails (firewalls, symmetric NATs, VPNs).

**Assessment: Industry standard, but operationally demanding.**

| Aspect | Detail |
|--------|--------|
| Reliability | Stable, RFC 5766-compliant |
| Users | Jitsi, Nextcloud Talk, thousands of WebRTC deployments |
| Maintenance | **15-20 hours/month** for production deployment |
| Security risk | Misconfigured auth = open relay = massive bandwidth bills |
| Multi-region | Essential — must deploy in every region you serve |
| TURN usage | 15-30% of calls (higher in enterprise environments) |

**TURN Alternatives:**

| Option | Cost | Pros | Cons |
|--------|------|------|------|
| Coturn (self-hosted) | Server cost only | Free, full control | Ops burden, must manage multi-region |
| Xirsys | From $10/mo | Easy setup, global network | Vendor dependency |
| Cloudflare TURN | $0.05/GB | Global CDN, cheap | Newer service |
| Twilio Network Traversal | $0.40/GB | Reliable, well-documented | Expensive |
| LiveKit (bundled) | Included | Zero extra setup | Tied to LiveKit |

**Recommendation:** Start with Coturn self-hosted for MVP. Evaluate managed TURN when scaling past a few hundred concurrent calls.

### 3.4 MongoDB (Database)

**Role:** Store user data, call history, room configuration, CDRs (Call Detail Records).

**Assessment: Acceptable for persistence, but CANNOT be the sole database.**

| Use Case | MongoDB | Redis | PostgreSQL |
|----------|---------|-------|------------|
| Real-time session state (who's in which room) | Too slow | **Best choice** | Too slow |
| Presence (online/offline/in-call) | Too slow | **Best choice** | Too slow |
| Ephemeral ICE candidates | Too slow | **Best choice** | Too slow |
| User profiles | Good | Wrong tool | Good |
| Call history / CDRs | Good | Wrong tool | **Better** (relational queries) |
| Billing / Subscriptions | Acceptable | Wrong tool | **Best** (ACID, relational integrity) |
| Room configuration | Good | Good (for active rooms) | Good |

**Critical finding: Redis is NOT optional.**

Real-time call state (room membership, presence, ICE candidates) requires sub-millisecond reads. MongoDB cannot deliver this reliably at scale. Every production WebRTC platform uses Redis or equivalent for ephemeral state.

**Decision for agcloud: MongoDB + Redis**
- **Redis** — real-time state, presence, pub/sub (mandatory from day 1)
- **MongoDB** — users, call history, CDRs, subscriptions, room config (document model fits flexible call metadata; team familiarity)
- The original concern ("MongoDB cannot serve real-time state at scale") is mitigated because Redis handles all hot-path real-time data. MongoDB stays on the cold path (persistent data only).
- Revisit PostgreSQL only if billing complexity grows substantially (financial reports, complex joins, strict ACID across entities).

---

## 4. Technical Risk Analysis

### 4.1 CRITICAL Risks

#### Risk 1: No Real-Time State Store
- **Impact:** System breaks above ~5K concurrent rooms if using MongoDB for room state
- **Mitigation:** Add Redis from day 1 for all ephemeral/real-time data

#### Risk 2: mediasoup Maintainer Risk (Bus Factor)
- **Impact:** If 2-3 maintainers stop contributing, you're maintaining a C++ media engine yourself
- **Mitigation:** Use LiveKit instead (VC-funded, full-time team) or budget for in-house C++ expertise

#### Risk 3: Bandwidth Cost Explosion
- **Impact:** At 1000 concurrent users, bandwidth alone costs $15-25K/month. TURN relay doubles cost for affected sessions
- **Mitigation:** Optimize with simulcast, adaptive bitrate. Use P2P for 1:1 calls. Monitor TURN usage ratios

#### Risk 4: WebRTC Debugging Blindness
- **Impact:** Without instrumentation, every call failure is a mystery. ICE failures are the #1 support ticket
- **Mitigation:** Build observability BEFORE features — SDP logs, ICE candidate traces, RTCP stats, call quality metrics (MOS score)

### 4.2 HIGH Risks

#### Risk 5: Socket.IO Scaling Wall
- **Impact:** Caps at ~10K connections/process. Requires migration to raw WebSockets under load
- **Mitigation:** Use raw WebSockets from the start, or use LiveKit (which handles signaling)

#### Risk 6: iOS/Safari Breakage
- **Impact:** iOS drops WebRTC connections when backgrounded >30s. H.264-only codec. API restrictions. Each Safari update may break your app
- **Mitigation:** Dedicated iOS testing pipeline. Native wrapper with `voip` UIBackgroundMode for background audio. H.264-first encoding strategy

#### Risk 7: TURN Operational Burden
- **Impact:** 15-20 hrs/month maintenance. Misconfigured auth = open relay = attackers use your server as a free VPN
- **Mitigation:** Time-limited credentials, per-user bandwidth caps, automated monitoring. Consider managed TURN at scale

#### Risk 8: Network Switching (Mobile)
- **Impact:** Wi-Fi to cellular handoff triggers ICE restart. Without handling, calls drop silently
- **Mitigation:** Implement `iceRestart` handling. Test on real mobile networks, not just office Wi-Fi

### 4.3 MEDIUM Risks

#### Risk 9: Security Surface
- **Signaling injection:** Forged SDP can redirect media streams. Always validate server-side
- **TURN abuse:** Open TURN = free VPN proxy. Mandatory credential rotation + bandwidth caps
- **Stream hijacking:** Weak room tokens allow unauthorized stream access. Use HMAC-signed, short-lived tokens
- **GDPR compliance:** Server-side recording without explicit per-participant consent is illegal in the EU

#### Risk 10: Codec Negotiation
- Safari sometimes omits VP9; Firefox handles simulcast differently from Chrome
- Mobile packet loss above 5% causes visible degradation that no FEC can fix

#### Risk 11: Offer/Answer State Machine Bugs
- Calling `setLocalDescription`/`setRemoteDescription` out of order causes silent failures
- "Offer collision" in perfect negotiation is a known source of race conditions

---

## 5. Cost Analysis

### 5.1 Infrastructure Costs by Scale

| Scale | Compute | Bandwidth | TURN | Total/Month |
|-------|---------|-----------|------|-------------|
| MVP (50 concurrent) | $50-100 | $500-1K | $200-500 | **$750-1.6K** |
| Small (500 concurrent) | $500-1K | $5-10K | $1.5-3K | **$7-14K** |
| Medium (1000 concurrent) | $2-4K | $15-25K | $3-5K | **$20-34K** |
| Large (5000 concurrent) | $10-20K | $75-125K | $15-25K | **$100-170K** |

### 5.2 Cost Breakdown

**Bandwidth** (60-70% of total cost):
- ~2.5 Mbps per 720p video stream
- Cloud egress: $0.05-0.08/GB (AWS/GCP/Azure)
- At 1000 concurrent users (500 rooms of 2): ~1.25 Gbps = **$15-25K/month**

**TURN Relay** (15-20% of total cost):
- Relayed traffic doubles bandwidth cost for affected calls
- Realistic TURN usage: 10-20% of all calls (higher in Asia/Middle East/enterprise)
- At 1000 users: **$3-5K/month** for TURN bandwidth

**Compute** (10-15% of total cost):
- mediasoup/LiveKit needs CPU-optimized instances (c5.2xlarge equivalent)
- At 1000 users: 4-8 instances = **$2-4K/month**

**Storage** (<5% of total cost):
- Call recordings (if enabled): ~100MB per hour of HD video
- Database: Negligible at this scale

### 5.3 Cost Optimization Strategies
1. Use **P2P for 1:1 calls** — no SFU needed, saves compute
2. **Simulcast** — send multiple quality layers, forward only what each recipient needs
3. **Adaptive bitrate** — reduce quality on poor networks instead of buffering
4. **Regional deployment** — reduce latency AND bandwidth by keeping traffic local
5. **Audio-only fallback** — dramatically reduces bandwidth (64Kbps vs 2.5Mbps)

---

## 6. Alternative Stack Recommendation

### 6.1 Proposed Stack vs Recommended Stack

| Component | Original Proposal | Recommended Alternative | Why |
|-----------|-------------------|------------------------|-----|
| Signaling | Socket.IO | **LiveKit** (built-in) | No polling overhead, no connection limits, built-in room management |
| SFU | mediasoup | **LiveKit** (built-in) | VC-funded, clustering, SDKs, recording — all built-in |
| TURN | Coturn | **LiveKit** (built-in) or Coturn | LiveKit bundles TURN; Coturn if self-hosting separately |
| Backend | Node.js | **Node.js** (keep) | Good choice — LiveKit has a Node.js server SDK |
| Database | MongoDB | **MongoDB + Redis** | MongoDB for persistent data (kept per team preference), Redis for real-time state |
| Real-time state | (none) | **Redis** (mandatory) | Sub-millisecond reads for presence, room state, pub/sub |

### 6.2 Why LiveKit?

LiveKit is an open-source (Apache 2.0) WebRTC infrastructure platform that replaces **three components** at once:

| Capability | With mediasoup (build yourself) | With LiveKit (included) |
|-----------|--------------------------------|------------------------|
| Signaling protocol | Custom Socket.IO events | Built-in room protocol |
| SFU media routing | mediasoup workers | Go-based SFU engine |
| TURN relay | Separate Coturn deployment | Embedded TURN |
| Simulcast | Manual configuration | Automatic (dynacast) |
| Recording | Build from scratch | Egress service (one API call) |
| Screen sharing | Manual implementation | SDK method call |
| Client SDKs | Build from scratch | JS, React, React Native, Android, iOS, Flutter, Unity, Rust |
| Multi-node scaling | Build pipeToRouter clustering | Built-in multi-node with Redis |
| Token auth | Build from scratch | JWT-based, built-in |
| Room management | Build from scratch | API + webhooks |

**LiveKit concrete numbers:**
- 22K+ GitHub stars (as of 2026)
- VC-funded with full-time engineering team
- Used in production by companies handling millions of concurrent calls
- Self-hostable via Docker or Kubernetes (official Helm charts)
- Also available as managed service (LiveKit Cloud)

**Time savings:** ~2-3 months of integration work eliminated by adopting LiveKit over raw mediasoup.

---

## 7. Architecture Suggestions

### 7.1 MVP Architecture: Modular Monolith

**Do NOT start with microservices.** They add deployment complexity that kills small-team velocity. Use a modular monolith with clean internal boundaries.

```
[Clients: Web / Mobile]
        |
        v
[Node.js API Server]  <-->  [Redis (real-time state + pub/sub)]
   |          |
   v          v
[LiveKit]  [MongoDB (persistent data)]
```

**Modules within Node.js API Server:**
- **Auth module** — user registration, login, JWT token generation
- **Room module** — create/join/leave rooms, LiveKit token generation
- **Call module** — call history, CDRs, analytics
- **User module** — profiles, contacts, permissions

### 7.2 Scaling Architecture (Phase 2-3)

```
[Clients]
    |
    v
[Load Balancer (geo-aware)]
    |
    +-> [API Server 1] <--> [Redis Cluster]
    +-> [API Server 2]        |
    +-> [API Server N]        v
                        [LiveKit Node 1 (Region A)]
                        [LiveKit Node 2 (Region B)]
                        [LiveKit Node N (Region C)]
                              |
                              v
                        [MongoDB (replica set: primary + secondaries)]
                        [Object Storage (recordings)]
```

### 7.3 Key Architecture Decisions

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Monolith vs Microservices | Monolith for MVP | Microservices kill small-team velocity |
| Message queue | Skip for MVP | Add NATS/RabbitMQ only when splitting into services (Phase 3+) |
| Container orchestration | Docker Compose for MVP | Graduate to K8s when needed. Media servers need `hostNetwork` mode |
| Multi-region | Single region for MVP | Expand when user base demands it |
| Redis Pub/Sub | From day 1 | Makes horizontal scaling trivial later |
| Token auth | From day 1 | HMAC-signed, short-lived JWT tokens for room access |
| Observability | From day 1 | SDP logs, ICE traces, RTCP stats, MOS scores. Build this BEFORE features |

### 7.4 What to Build vs What LiveKit Provides

| You Build | LiveKit Provides |
|-----------|-----------------|
| User authentication & authorization | Media transport (SFU) |
| Business logic (call routing, permissions) | Signaling protocol |
| Call history & analytics | TURN/ICE handling |
| Billing & usage tracking | Simulcast & adaptive bitrate |
| Custom UI/UX | Client SDKs (JS, Android, iOS, etc.) |
| Developer portal & API docs (Phase 4) | Recording & egress |
| Push notifications | Room management & webhooks |

---

## 8. Open-Source Projects to Study

| Project | What to Learn | URL |
|---------|--------------|-----|
| **LiveKit** | Room protocol, token auth, egress, multi-node scaling | github.com/livekit/livekit |
| **Jitsi Meet** | Battle-tested room management, recording, large-scale deployment | github.com/jitsi/jitsi-meet |
| **Element/Matrix** | Signaling protocol design, federation, E2E encryption | github.com/element-hq |
| **BigBlueButton** | Recording/playback architecture, education-focused features | github.com/bigbluebutton |
| **PeerJS** | Simple P2P WebRTC abstraction (study for understanding, not for production) | github.com/peers/peerjs |

---

## 9. Smart MVP Strategy

### 9.1 With LiveKit (Recommended — 6 weeks)

| Week | Deliverable |
|------|------------|
| **1-2** | LiveKit self-hosted (Docker Compose) + Node.js API server + MongoDB + Redis. Implement: user auth, token generation, room creation, 1:1 audio/video calls |
| **3-4** | Group calls (LiveKit handles natively), mute/unmute, camera toggle, screen share, call history persistence, basic call quality monitoring |
| **5-6** | Recording (LiveKit Egress), call accept/reject flow with push notifications, basic admin dashboard, load testing |

### 9.2 With mediasoup (Original — 14-16 weeks)

| Week | Deliverable |
|------|------------|
| **1-3** | Socket.IO signaling server, WebRTC P2P connection, SDP/ICE exchange, basic 1:1 calls |
| **4-6** | Coturn deployment, TURN fallback, network traversal testing across real networks |
| **7-9** | mediasoup integration, SFU-based group calls, simulcast configuration |
| **10-12** | Mute/unmute, camera toggle, screen sharing, call accept/reject, call history |
| **13-14** | Recording pipeline (build from scratch), quality monitoring, admin dashboard |
| **15-16** | Load testing, iOS/Safari fixes, production hardening |

### 9.3 Phase Progression

| Phase | Scope | Prerequisites |
|-------|-------|---------------|
| **Phase 1: MVP** | 1:1 and group calls, basic features | Core infrastructure |
| **Phase 2: Production** | Multi-region, monitoring, adaptive quality | Validated MVP with real users |
| **Phase 3: Platform** | Developer SDKs, API, documentation portal | Stable production infrastructure |
| **Phase 4: Advanced** | AI noise suppression, live streaming, video filters | Revenue or funding to support R&D |

---

## 10. Build vs Buy Analysis

### 10.1 When to Build Your Own

| Scale | Recommendation |
|-------|---------------|
| < 10K concurrent users | **Buy** — Twilio/Agora/Daily.co is almost certainly cheaper than engineering + ops |
| 10K-50K concurrent | **Grey zone** — self-hosting starts making economic sense if you have the team |
| 50K-100K+ concurrent | **Build** — self-hosting is clearly the better option |

### 10.2 Cost Comparison

**At 1000 concurrent users:**

| Approach | Monthly Cost |
|----------|-------------|
| **Twilio Video** | ~$8-15K (usage-based) |
| **Agora** | ~$5-12K (usage-based) |
| **Self-hosted (LiveKit)** | ~$20-34K (infra) + engineering salaries |
| **Self-hosted (mediasoup)** | ~$20-34K (infra) + more engineering salaries |

**The hidden cost of self-hosting:** Engineering time. A 3-person team spending 50% of their time on video infrastructure costs $15-25K/month in salary alone. Below 50K concurrent users, this often exceeds vendor pricing.

### 10.3 When Self-Hosting Makes Sense Despite Cost

- **Data sovereignty:** You must keep media on your own servers (healthcare, government, defense)
- **Customization:** Vendor SDKs don't support your use case (custom codecs, AI processing pipeline)
- **Strategic investment:** Video calling IS your product, not a feature (building a Twilio competitor)
- **Learning:** Deep understanding of WebRTC and real-time systems is the goal

### 10.4 Common Startup Mistakes

1. **Underestimating ops burden** — WebRTC infra requires 24/7 monitoring of ICE success rates, packet loss, MOS scores. Most teams build none of this before launch
2. **Building rooms before building observability** — When a call fails, you need SDP logs, ICE traces, and RTCP stats. Without them, debugging is guesswork
3. **Testing only on office Wi-Fi** — Real users are on 3G, behind corporate proxies, or in regions where STUN/TURN may be blocked
4. **Going self-hosted to save money** — Engineering time is the real cost, not servers
5. **Starting with microservices** — Adds 2-3x deployment complexity for zero benefit at MVP stage

---

## 11. Sources & References

### WebRTC Feasibility
- [Why WebRTC Remains Deceptively Complex in 2025](https://webrtc.ventures/2025/08/why-webrtc-remains-deceptively-complex-in-2025/)
- [WebRTC Browser Support 2026: Complete Compatibility Guide](https://antmedia.io/webrtc-browser-support/)
- [7 WebRTC Trends Shaping Real-Time Communication in 2026](https://dev.to/alakkadshaw/7-webrtc-trends-shaping-real-time-communication-in-2026-1o07)

### SFU Comparisons
- [Jitsi Videobridge vs Mediasoup vs Janus](https://www.cloverdynamics.com/blogs/jitsi-videobridge-vs-mediasoup-vs-janus)
- [Janus vs LiveKit vs mediasoup Comparison](https://mylinehub.com/articles/janus-vs-livekit-vs-mediasoup-webrtc-server-comparison)
- [Janus vs Mediasoup vs LiveKit for Telemedicine](https://trembit.com/blog/choosing-the-right-sfu-janus-vs-mediasoup-vs-livekit-for-telemedicine-platforms/)

### Scaling & Architecture
- [mediasoup Scalability Documentation](https://mediasoup.org/documentation/v3/scalability/)
- [LiveKit Can Handle Millions of Concurrent Calls](https://medium.com/@BeingOttoman/livekit-can-handle-millions-of-concurrent-calls-crazy-1f2517165e04)
- [WebRTC System Design for 10K+ Concurrent Users](https://www.hirevoipdeveloper.com/blog/how-to-architect-webrtc-systems-for-10k-concurrent-users/)
- [Scaling WebRTC to 10,000 Devices](https://amsiot.com/blog/scaling-webrtc-to-10000-devices/)

### Cost Analysis
- [How Much Does It Really Cost to Build and Run a WebRTC Application?](https://webrtc.ventures/2025/10/how-much-does-it-really-cost-to-build-and-run-a-webrtc-application/)
- [TURN Server Costs: A Complete Guide](https://dev.to/alakkadshaw/turn-server-costs-a-complete-guide-1c4b)
- [TURN Server Providers Comparison](https://soufianebouchaara.com/turn-server-providers-a-comprehensive-comparison-and-handling-massive-production-without-voice-impact/)

### Performance & Networking
- [WebRTC Latency: Comparing Low-Latency Streaming Protocols](https://www.nanocosmos.net/blog/webrtc-latency/)
- [Socket.IO Performance Tuning](https://socket.io/docs/v4/performance-tuning/)
- [The Ultimate WebSocket Battle: Elixir vs Go](https://medium.com/beamworld/the-ultimate-websocket-battle-elixir-vs-go-performance-showdown-5d0ee199edf2)
- [TURN Server for WebRTC: Complete Guide](https://www.videosdk.live/developer-hub/webrtc/turn-server-for-webrtc)

### Alternative Platforms
- [From Mediasoup to LiveKit Self-Hosted](https://www.slideshare.net/slideshow/from-mediasoup-webrtc-to-livekit-selfhosted-pdf/264685078)
- [Twilio TURN Server Alternatives](https://www.videosdk.live/developer-hub/stun-turn-server/twilio-turn-server-alternative)
- [Top Open Source Video Call SDKs 2025](https://jitsi.support/comparison/best-open-source-video-sdks-2025/)
- [WebRTC Open Source Media Servers 2024](https://bloggeek.me/webrtc-open-source-media-servers-github-2024/)
- [Companies Using Mediasoup](https://theirstack.com/en/technology/mediasoup)
