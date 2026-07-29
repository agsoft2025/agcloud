# agcloud Backend: Node.js Module Specification

> **Date:** 2026-04-16
> **Scope:** Detailed technical specification for the Node.js backend
> **Architecture:** Modular monolith with clear separation of concerns
> **Stack:** Node.js + Fastify + MongoDB + Redis + LiveKit Server SDK

---

## Table of Contents
1. [Overview & Architecture](#1-overview--architecture)
2. [Module Breakdown](#2-module-breakdown)
3. [Data Models (MongoDB)](#3-data-models-mongodb)
4. [API Specification (REST)](#4-api-specification-rest)
5. [Security](#5-security)
6. [Reliability](#6-reliability)
7. [Observability](#7-observability)
8. [Scalability & High Availability](#8-scalability--high-availability)
9. [Configuration & Secrets](#9-configuration--secrets)
10. [Testing Strategy](#10-testing-strategy)
11. [Deployment](#11-deployment)

---

## 1. Overview & Architecture

### 1.1 Service Responsibilities

| Responsibility | Description |
|---------------|-------------|
| **Authentication & Authorization** | User signup/signin, JWT issuance, refresh, RBAC |
| **Call Lifecycle Management** | Initiate, ring, accept, reject, end calls |
| **LiveKit Orchestration** | Room creation, token generation, webhook processing |
| **User Management** | Profiles, contacts, blocklist, presence |
| **Push Notifications** | Wake up callees via FCM/APNs |
| **Persistence** | Call history, CDRs, audit logs |
| **Real-time State** | Active calls, presence, rate limits via Redis |

### 1.2 Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| HTTP Framework | **Fastify** | 2-3x faster than Express, built-in JSON Schema validation, native logger |
| Database | **MongoDB** + **Mongoose** | Document model, team familiarity |
| Cache / Real-time | **Redis** + **ioredis** | Battle-tested client, cluster support |
| LiveKit SDK | **livekit-server-sdk** | Official SDK |
| Validation | **Zod** | Type-safe runtime validation, TS inference |
| Auth | **jsonwebtoken** + **argon2** | Industry standards (argon2 > bcrypt) |
| Logger | **Pino** | Fastest structured logger, JSON output |
| Metrics | **prom-client** | Prometheus standard |
| Tracing | **OpenTelemetry** | Vendor-neutral observability |
| Push | **firebase-admin** + **node-apn** | FCM (Android/Web) + APNs (iOS) |
| Testing | **Vitest** + **Supertest** | Fast, modern, ESM-native |
| Process Manager | **PM2** or container | Cluster mode in single VM |

### 1.3 High-Level Architecture

```
                  +-----------------------------------------+
                  |       agcloud Backend (Fastify)          |
                  |                                         |
   HTTP/WSS  ---> |  +-----------------------------------+  |
                  |  |       Middleware Pipeline         |  |
                  |  | request-id -> tracing ->          |  |
                  |  | auth -> rate-limit -> validate -> |  |
                  |  | route -> error-handler            |  |
                  |  +-----------------------------------+  |
                  |               |                         |
                  |               v                         |
                  |  +-----------------------------------+  |
                  |  |       Module Layer (HTTP)         |  |
                  |  |  Auth | User | Call | Webhook     |  |
                  |  +-----------------------------------+  |
                  |               |                         |
                  |               v                         |
                  |  +-----------------------------------+  |
                  |  |     Service Layer (logic)         |  |
                  |  |  AuthService | CallService |      |  |
                  |  |  LiveKitService | NotifService    |  |
                  |  +-----------------------------------+  |
                  |               |                         |
                  |               v                         |
                  |  +-----------------------------------+  |
                  |  |     Data Access Layer             |  |
                  |  |  Repositories (MongoDB) +         |  |
                  |  |  Cache (Redis)                    |  |
                  |  +-----------------------------------+  |
                  +-----------------+-----------------------+
                                    |
        +---------------+-----------+----------+---------------+
        |               |                      |               |
        v               v                      v               v
   +---------+    +---------+         +-------------+    +---------+
   | MongoDB |    |  Redis  |         |   LiveKit   |    |FCM/APNs |
   +---------+    +---------+         +-------------+    +---------+
```

### 1.4 Module Layering Rules

| Layer | Can Import From | Cannot Import From |
|-------|----------------|---------------------|
| Routes (HTTP) | Services, DTOs | Repositories, Models |
| Services (Logic) | Repositories, other Services, External Clients | Routes, HTTP types |
| Repositories | Models | Services, Routes |
| Models | (nothing) | Anything |

---

## 2. Module Breakdown

### 2.1 Auth Module

**Responsibilities:**
- User signup/signin with email + password
- JWT access token (15 min TTL) + refresh token (7 days, rotated)
- Password reset via email
- Session revocation
- Optional OAuth (Google, Apple)

**Key Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/signup` | Register new user |
| POST | `/auth/signin` | Authenticate, return tokens |
| POST | `/auth/refresh` | Rotate refresh token, issue new access token |
| POST | `/auth/signout` | Revoke refresh token |
| POST | `/auth/forgot-password` | Send reset email |
| POST | `/auth/reset-password` | Set new password with reset token |

**Critical Decisions:**
- Refresh tokens stored hashed in MongoDB with `userId`, `deviceId`, `expiresAt`
- Access tokens are stateless JWTs — no DB lookup on each request
- Password hashing: **argon2id** with `memoryCost: 19456, timeCost: 2, parallelism: 1`
- Rate limit: 5 attempts/min per IP for signin/signup

### 2.2 User Module

**Responsibilities:**
- Profile CRUD
- Contact list management
- Blocklist
- Presence query (online/offline/in-call)

**Key Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/users/me` | Current user profile |
| PATCH | `/users/me` | Update profile |
| GET | `/users/:id` | Public profile (limited fields) |
| GET | `/users/me/contacts` | Contact list |
| POST | `/users/me/contacts` | Add contact |
| DELETE | `/users/me/contacts/:id` | Remove contact |
| POST | `/users/me/block/:id` | Block user |
| GET | `/users/:id/presence` | Get online/offline state (Redis) |

### 2.3 Call Module

**Responsibilities:**
- Initiate outgoing calls (1:1 and group)
- Handle accept/reject/cancel/timeout
- LiveKit room provisioning
- Token issuance per participant
- Push notification dispatch
- Call history persistence

**Key Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/calls/initiate` | Start a call (creates room, sends push) |
| POST | `/calls/:id/accept` | Callee accepts, returns LiveKit token |
| POST | `/calls/:id/reject` | Callee rejects |
| POST | `/calls/:id/cancel` | Caller cancels before pickup |
| POST | `/calls/:id/end` | End ongoing call |
| GET | `/calls/history` | Paginated call history |
| GET | `/calls/:id` | Single call details |

**Call State Machine:**
```
   [initiating] --> [ringing] --+--> [accepted] --> [active] --> [ended]
                                |
                                +--> [rejected]
                                +--> [missed]      (timeout)
                                +--> [cancelled]   (caller cancelled)
                                +--> [busy]        (callee in another call)
```

State persisted in Redis (TTL=1h) for active calls; final state written to MongoDB on `[ended]`/`[rejected]`/`[missed]`/`[cancelled]`.

### 2.4 LiveKit Module

**Responsibilities:**
- Wrap LiveKit server SDK
- Token generation with proper grants
- Room create/delete/inspect
- Egress (recording) management
- Webhook signature verification & dispatch

**Key Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/livekit/webhook` | Receive LiveKit events (signature-verified) |

**Webhook Events Handled:**
- `room_started` — log room start
- `room_finished` — finalize call, calculate duration, write to MongoDB
- `participant_joined` — update call state to `active`
- `participant_left` — handle hangup, update state
- `track_published` / `track_unpublished` — for audio-only/video toggles
- `egress_ended` — store recording URL in call doc

### 2.5 Notification Module

**Responsibilities:**
- Send FCM push to Android/Web
- Send APNs push to iOS (with VoIP push for calls)
- Device token management (register/unregister)
- Retry on transient failures (exponential backoff)

**Key Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/devices/register` | Register FCM/APNs device token |
| DELETE | `/devices/:tokenId` | Unregister device token |

### 2.6 Health & Admin Module

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health/live` | none | Liveness (k8s) — process is up |
| GET | `/health/ready` | none | Readiness — deps are reachable |
| GET | `/metrics` | internal | Prometheus metrics scrape |
| GET | `/admin/calls/active` | admin | Live call inspection |

---

## 3. Data Models (MongoDB)

### 3.1 `users` Collection

```javascript
{
  _id: ObjectId,
  email: String,                      // unique index
  emailVerified: Boolean,
  passwordHash: String,               // argon2id
  displayName: String,
  avatarUrl: String,
  phoneNumber: String,                // optional, unique sparse index
  status: 'active' | 'suspended' | 'deleted',
  preferences: {
    notifications: { calls: Boolean, missedCalls: Boolean },
    privacy: { allowCallsFrom: 'contacts' | 'anyone' }
  },
  createdAt: Date,
  updatedAt: Date,
  lastSeenAt: Date
}
```

**Indexes:** `{ email: 1 }` unique, `{ phoneNumber: 1 }` sparse unique, `{ createdAt: -1 }`

### 3.2 `refresh_tokens` Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId,                   // index
  tokenHash: String,                  // SHA-256 of refresh token
  deviceId: String,
  userAgent: String,
  ipAddress: String,
  expiresAt: Date,                    // TTL index
  revokedAt: Date | null,
  createdAt: Date
}
```

**Indexes:** `{ userId: 1 }`, `{ tokenHash: 1 }` unique, `{ expiresAt: 1 }` TTL

### 3.3 `calls` Collection

```javascript
{
  _id: ObjectId,
  roomName: String,                   // LiveKit room name (unique)
  type: '1on1' | 'group',
  status: 'initiating' | 'ringing' | 'active' | 'ended' | 'rejected' | 'missed' | 'cancelled',
  initiatorId: ObjectId,              // index
  participants: [{
    userId: ObjectId,
    joinedAt: Date | null,
    leftAt: Date | null,
    deviceInfo: { os, browser, version }
  }],
  features: { audio: Boolean, video: Boolean, screenShare: Boolean },
  recording: {
    enabled: Boolean,
    egressId: String | null,
    fileUrl: String | null
  },
  startedAt: Date,
  endedAt: Date | null,
  durationSec: Number | null,
  endReason: 'hangup' | 'timeout' | 'error' | 'rejected' | null,
  createdAt: Date
}
```

**Indexes:** `{ initiatorId: 1, createdAt: -1 }`, `{ 'participants.userId': 1, createdAt: -1 }`, `{ roomName: 1 }` unique, `{ status: 1, createdAt: -1 }`

### 3.4 `devices` Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId,                   // index
  platform: 'ios' | 'android' | 'web',
  pushToken: String,
  voipToken: String | null,           // iOS VoIP push (PushKit)
  deviceId: String,
  appVersion: String,
  lastSeenAt: Date,
  createdAt: Date
}
```

**Indexes:** `{ userId: 1 }`, `{ pushToken: 1 }` unique

### 3.5 `audit_logs` Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId | null,
  action: String,                     // 'auth.signin', 'call.initiate', etc.
  resource: { type: String, id: String },
  result: 'success' | 'failure',
  metadata: Object,
  ipAddress: String,
  userAgent: String,
  timestamp: Date                     // TTL index (90 days)
}
```

**Indexes:** `{ userId: 1, timestamp: -1 }`, `{ action: 1, timestamp: -1 }`, `{ timestamp: 1 }` TTL 90d

### 3.6 Redis Keys

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `session:{tokenJti}` | hash | access token TTL | Token blacklist (revoked tokens) |
| `presence:{userId}` | string | 90s (heartbeat) | online / offline / in-call |
| `call:{callId}:state` | hash | 1h | Call state machine |
| `call:{callId}:participants` | set | 1h | Active participants |
| `ratelimit:{ip}:{route}` | counter | 60s | Rate limiting |
| `lock:{resource}` | string | 30s | Distributed lock (Redlock) |
| `pubsub:presence` | channel | — | Presence updates broadcast |
| `pubsub:calls` | channel | — | Call events broadcast |

---

## 4. API Specification (REST)

### 4.1 Conventions

- **Base URL:** `https://api.agcloud.example.com/v1`
- **Authentication:** `Authorization: Bearer <access_token>` for protected routes
- **Content-Type:** `application/json`
- **Idempotency:** `Idempotency-Key: <uuid>` header for POST mutations (call.initiate, call.accept)
- **Pagination:** Cursor-based: `?cursor=<id>&limit=20` (max 100)
- **Errors:** [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807) format

### 4.2 Standard Error Response

```json
{
  "type": "https://api.agcloud.example.com/errors/invalid-credentials",
  "title": "Invalid credentials",
  "status": 401,
  "detail": "Email or password is incorrect",
  "instance": "/v1/auth/signin",
  "requestId": "req_01HXY..."
}
```

### 4.3 Sample Endpoint: `POST /calls/initiate`

**Request:**
```json
{
  "calleeIds": ["64f8...a1b2"],
  "type": "1on1",
  "features": { "audio": true, "video": true },
  "recording": false
}
```

**Headers:** `Authorization: Bearer ...`, `Idempotency-Key: <uuid>`

**Response 201:**
```json
{
  "callId": "65a1...c3d4",
  "roomName": "call-65a1c3d4",
  "livekitUrl": "wss://livekit.agcloud.example.com",
  "token": "eyJhbGc...",
  "expiresAt": "2026-04-16T15:30:00Z"
}
```

**Errors:**
| Code | Type | Cause |
|------|------|-------|
| 400 | `validation-failed` | Bad request body |
| 401 | `invalid-credentials` | Missing/expired token |
| 403 | `forbidden` | Caller blocked by callee |
| 404 | `user-not-found` | Callee does not exist |
| 409 | `callee-busy` | Callee already in another call |
| 429 | `rate-limited` | Too many call attempts |
| 503 | `livekit-unavailable` | LiveKit room creation failed |

---

## 5. Security

### 5.1 Authentication

| Concern | Implementation |
|---------|---------------|
| Password storage | **argon2id** (`memoryCost: 19456, timeCost: 2`) |
| Access tokens | **JWT (HS256 or RS256)** with 15-min TTL, contains `userId`, `roles`, `jti` |
| Refresh tokens | **Opaque random 256-bit**, hashed in DB, rotated on every refresh |
| Token revocation | Refresh tokens deletable; access tokens checked against `session:{jti}` blacklist on auth |
| MFA (Phase 2) | TOTP via authenticator apps; SMS as fallback |

**JWT Best Practices:**
- Short access TTL (15 min)
- Refresh token rotation: each refresh issues new pair, invalidates old refresh
- Reuse detection: if revoked refresh token is presented, revoke entire family (all sessions for user)
- Use `kid` header for key rotation
- Validate `iss`, `aud`, `exp`, `nbf` on every request

### 5.2 Authorization

| Pattern | Implementation |
|---------|---------------|
| **RBAC** | Roles: `user`, `admin`. Embedded in JWT claims |
| **Resource ownership** | Service-layer checks: `assertOwns(userId, resource)` |
| **Call permissions** | Call participants only can read/end the call |
| **Admin operations** | Required `admin` role, audit-logged |

### 5.3 Input Validation

- **Zod schemas** for every request body, query, params
- Reject unknown fields by default (`.strict()`)
- Validate at the route boundary; services trust validated input
- File uploads: MIME type + magic-byte verification, max size limits

### 5.4 Rate Limiting

| Scope | Limit | Storage |
|-------|-------|---------|
| Per-IP global | 100 req/min | Redis sliding window |
| `POST /auth/signin` | 5 req/min per IP | Redis |
| `POST /auth/signup` | 3 req/min per IP | Redis |
| `POST /calls/initiate` | 10 req/min per user | Redis |
| `POST /auth/forgot-password` | 1 req/5 min per email | Redis |

Implementation: **rate-limiter-flexible** with Redis store.

### 5.5 Transport Security

- **TLS 1.2+** only (TLS 1.3 preferred)
- **HSTS** header: `max-age=31536000; includeSubDomains; preload`
- **Certificate pinning** in mobile clients
- **CSP**, **X-Content-Type-Options**, **X-Frame-Options** via `@fastify/helmet`
- **CORS:** explicit allowlist of origins; no `*`

### 5.6 Secrets Management

- **No secrets in code or git**
- Production: **AWS Secrets Manager / HashiCorp Vault / GCP Secret Manager**
- Development: `.env` files, never committed (`.env.example` is committed)
- Rotation: JWT signing keys every 90 days; LiveKit API secrets every 180 days
- Database credentials: rotated quarterly, atomic rollover via secret versions

### 5.7 OWASP Top 10 Mitigations

| Risk | Mitigation |
|------|-----------|
| **A01 Broken Access Control** | RBAC + per-resource ownership checks; deny by default |
| **A02 Cryptographic Failures** | TLS everywhere, argon2id, HMAC-signed JWTs, no PII in logs |
| **A03 Injection** | Zod validation, parameterized Mongoose queries, no `eval` |
| **A04 Insecure Design** | Threat modeling at design time, principle of least privilege |
| **A05 Security Misconfiguration** | `helmet`, secure cookie flags, disable `x-powered-by` |
| **A06 Vulnerable Components** | `npm audit` in CI, Snyk/Dependabot, lockfile maintained |
| **A07 Auth Failures** | Argon2, rate limit, refresh rotation, lockout after 10 failed attempts |
| **A08 Data Integrity** | npm package signatures, supply chain audit, pinned dep versions |
| **A09 Logging Failures** | Structured logs, log auth events to `audit_logs` |
| **A10 SSRF** | No user-controlled URL fetching; if needed, allowlist |

### 5.8 Webhook Signature Verification

LiveKit webhooks must be authenticated:
```javascript
import { WebhookReceiver } from 'livekit-server-sdk';

const receiver = new WebhookReceiver(API_KEY, API_SECRET);

fastify.post('/livekit/webhook', async (req, reply) => {
  const event = receiver.receive(req.body, req.headers.authorization);
  // signature validated; process event
});
```

### 5.9 PII & Privacy

- Encrypt PII at rest using **MongoDB Client-Side Field-Level Encryption** for `phoneNumber`, `email`
- **GDPR right-to-erasure**: hard-delete user + cascade to calls (anonymize participant references)
- **Data retention**: audit logs 90 days, call recordings configurable per user (default 30 days)
- **Consent tracking**: per-user consent for call recording; reject if any participant did not consent

---

## 6. Reliability

### 6.1 Error Handling Strategy

| Error Type | Response | Logged? | Retry? |
|-----------|----------|---------|--------|
| **Validation (4xx)** | Detailed message | INFO | No (client must fix) |
| **Authentication (401)** | Generic message | WARN | No |
| **Authorization (403)** | Generic message | WARN | No |
| **Resource not found (404)** | Generic message | INFO | No |
| **Conflict (409)** | Specific message | INFO | No |
| **Rate limit (429)** | `Retry-After` header | INFO | Yes (with backoff) |
| **Internal (5xx)** | Generic + requestId | ERROR | Yes (with backoff) |
| **Dependency unavailable (503)** | Specific code | ERROR | Yes (with circuit breaker) |

### 6.2 Idempotency

| Operation | Mechanism |
|-----------|-----------|
| `POST /calls/initiate` | `Idempotency-Key` header → Redis `idempotency:{key}` for 24h |
| `POST /calls/:id/accept` | DB-level: state transition is idempotent (ringing -> accepted) |
| `POST /devices/register` | Upsert by `(userId, pushToken)` |
| Webhook handlers | Event ID dedup in Redis (24h) |

### 6.3 Retry & Backoff

| External Call | Strategy |
|---------------|----------|
| LiveKit Twirp API | 3 retries, exponential backoff (100ms, 400ms, 1.6s), only on 5xx |
| FCM/APNs push | 5 retries, exponential, max 60s, dead-letter on persistent failure |
| MongoDB | Driver default (network errors), max 30s |
| Redis | Driver default + reconnect strategy |

Library: **`p-retry`** with **`p-timeout`** wrapping.

### 6.4 Circuit Breakers

For each external dependency: **opossum** circuit breaker.

| Dependency | Threshold | Timeout | Reset |
|-----------|-----------|---------|-------|
| LiveKit | 50% failure rate over 30s | 5s | 60s |
| FCM | 50% over 60s | 10s | 120s |
| APNs | 50% over 60s | 10s | 120s |

When open: fast-fail with `503 service-unavailable` and clear message. Push falls back to queue (BullMQ).

### 6.5 Graceful Shutdown

```
SIGTERM received
    |
    v
Stop accepting new connections (close HTTP server)
    |
    v
Wait for in-flight requests (max 30s)
    |
    v
Close LiveKit clients, FCM/APNs clients
    |
    v
Flush logs, metrics
    |
    v
Disconnect MongoDB and Redis
    |
    v
Exit 0
```

Implementation via Fastify's `onClose` hooks.

### 6.6 Database Reliability

- **Write concern:** `{ w: 'majority', wtimeout: 5000 }` for critical writes (calls, users)
- **Read concern:** `'local'` for hot reads, `'majority'` for finance/audit
- **Transactions:** Multi-document transactions for refresh-token rotation (revoke old + insert new atomically)
- **Schema validation:** MongoDB JSON Schema validators on each collection
- **Backups:** Daily snapshots + continuous oplog backup (PITR), 30-day retention

### 6.7 Failure Modes & Responses

| Failure | Response |
|---------|----------|
| MongoDB primary down | Driver auto-failover to secondary; readiness probe fails for 10s |
| Redis down | Hot data unavailable; degrade gracefully (skip rate limit, write to fallback log) |
| LiveKit down | Calls fail at initiate with `503`; existing calls continue (LiveKit-side) |
| Push provider down | Notifications queued (BullMQ), retried; users see offline callee |
| Single backend instance crashes | Load balancer routes to healthy instances |

---

## 7. Observability

### 7.1 Structured Logging

**Library:** Pino (built into Fastify)

**Log levels:**
- `fatal` — process about to die
- `error` — request failed, alert-worthy
- `warn` — abnormal but handled (retry, fallback engaged)
- `info` — request lifecycle, key state changes
- `debug` — verbose; off in production by default
- `trace` — extreme detail; only ad-hoc

**Required fields on every log entry:**
```json
{
  "level": "info",
  "time": 1745420400000,
  "service": "agcloud-backend",
  "version": "1.4.2",
  "env": "production",
  "requestId": "req_01HXY...",
  "traceId": "0af7651916cd43dd...",
  "spanId": "b7ad6b7169203331",
  "userId": "65a1...",
  "msg": "call.initiate.success",
  "callId": "65a2...",
  "calleeId": "64f8...",
  "durationMs": 142
}
```

**PII redaction (built into Pino):**
```javascript
{
  redact: {
    paths: ['req.headers.authorization', 'req.body.password', 'user.email'],
    censor: '[REDACTED]'
  }
}
```

### 7.2 Metrics (Prometheus)

**Library:** `prom-client`. Endpoint: `GET /metrics` (internal only, scraped by Prometheus).

**Standard metrics (RED):**

| Metric | Type | Labels |
|--------|------|--------|
| `http_requests_total` | Counter | method, route, status_code |
| `http_request_duration_seconds` | Histogram | method, route, status_code |
| `http_requests_in_flight` | Gauge | — |

**Business metrics:**

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `agcloud_calls_initiated_total` | Counter | type | Call volume |
| `agcloud_calls_completed_total` | Counter | end_reason | Call outcomes |
| `agcloud_calls_active` | Gauge | — | Concurrent calls |
| `agcloud_call_duration_seconds` | Histogram | type | Call length distribution |
| `agcloud_signin_attempts_total` | Counter | result | Auth health |
| `agcloud_push_notifications_total` | Counter | platform, result | Push reliability |
| `agcloud_livekit_room_create_seconds` | Histogram | — | LiveKit latency |
| `agcloud_circuit_breaker_state` | Gauge | dependency | 0=closed, 1=open, 2=half-open |

**Infrastructure metrics:**
- Node.js: `nodejs_eventloop_lag_seconds`, `nodejs_heap_size_used_bytes`, `process_cpu_user_seconds_total`
- MongoDB: `mongo_pool_size`, `mongo_query_duration_seconds`
- Redis: `redis_connected`, `redis_command_duration_seconds`

### 7.3 Distributed Tracing (OpenTelemetry)

**Setup:**
- `@opentelemetry/sdk-node` auto-instruments: HTTP server, MongoDB, Redis, outgoing HTTP
- Custom spans for: LiveKit operations, push notifications, business workflows
- Exporter: OTLP to **Tempo / Jaeger / Honeycomb / Datadog**
- Sampling: head-based 100% in dev, 10% in prod (with tail-based for errors via collector)

**Trace propagation:**
- Inbound: parse `traceparent` (W3C Trace Context) header
- Outbound: inject `traceparent` in all HTTP/Twirp calls
- Logs include `traceId` + `spanId` for correlation

### 7.4 Health Checks

| Endpoint | Check | Response Time SLA |
|----------|-------|-------------------|
| `GET /health/live` | Process running, event loop responsive | <50ms |
| `GET /health/ready` | MongoDB ping, Redis ping, LiveKit reachable | <500ms |

**Liveness:**
```json
{ "status": "ok", "uptime": 3421 }
```

**Readiness:**
```json
{
  "status": "ok",
  "checks": {
    "mongodb": { "status": "ok", "latencyMs": 3 },
    "redis": { "status": "ok", "latencyMs": 1 },
    "livekit": { "status": "ok", "latencyMs": 28 }
  }
}
```

If any dependency fails, return **503**. Kubernetes will stop routing traffic.

### 7.5 Alerting Strategy

**Tiers:**
- **P0 (page immediately):** Total outage, data loss risk, security breach
- **P1 (page during business hours):** Degraded service, error spikes
- **P2 (Slack channel):** Anomalies, capacity warnings

**Sample alert rules (Prometheus):**

| Alert | Condition | Severity |
|-------|-----------|----------|
| `BackendDown` | `up{job="agcloud-backend"} == 0` for 2m | P0 |
| `HighErrorRate` | `rate(http_requests_total{status_code=~"5.."}[5m]) > 0.05` for 5m | P0 |
| `HighLatencyP99` | `histogram_quantile(0.99, http_request_duration_seconds) > 1` for 10m | P1 |
| `EventLoopLag` | `nodejs_eventloop_lag_seconds > 0.1` for 5m | P1 |
| `CircuitBreakerOpen` | `agcloud_circuit_breaker_state{state="open"} == 1` for 2m | P1 |
| `MongoDBSlow` | `histogram_quantile(0.95, mongo_query_duration_seconds) > 0.5` for 10m | P1 |
| `RefreshTokenAbuse` | `rate(agcloud_refresh_token_reuse_total[5m]) > 0.1` | P0 (security) |
| `LiveKitErrors` | `rate(agcloud_livekit_errors_total[5m]) > 0.05` | P1 |
| `PushFailureRate` | `rate(agcloud_push_notifications_total{result="failure"}[5m]) > 0.1` | P2 |
| `LowDiskSpace` | `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1` | P1 |

**Tooling:** Prometheus + Alertmanager → PagerDuty / Opsgenie / Slack.

### 7.6 SLOs (Service Level Objectives)

| Service | SLO | Measurement Window |
|---------|-----|---------------------|
| API availability | 99.9% (≤ 43m downtime/month) | 30-day rolling |
| API p99 latency | < 500ms | 5-minute window |
| Call setup time | < 2s p95 | 5-minute window |
| Push delivery | 95% within 10s | 1-hour window |
| Webhook processing | 99% within 5s | 5-minute window |

### 7.7 Audit Logging

All security-sensitive operations write to `audit_logs` collection:
- Authentication events (signin, signout, password change, token rotation)
- Authorization failures
- Admin actions
- Data exports / GDPR requests
- Privilege escalations

Retention: 90 days (TTL index). For longer retention, ship to cold storage (S3 + Glacier).

---

## 8. Scalability & High Availability

### 8.1 Stateless Service Design

The backend is **stateless** — no in-memory session, cache, or queue state. Any request can be routed to any instance.

**State locations:**
- User session: JWT (client-side) + refresh token (MongoDB)
- Cache: Redis (shared)
- Queues: BullMQ on Redis
- Locks: Redlock on Redis

**Result:** Trivially horizontally scalable.

### 8.2 Horizontal Scaling

| Component | Scaling Strategy |
|-----------|-----------------|
| Backend instances | Kubernetes HPA on CPU + custom metric (`http_requests_in_flight`) |
| MongoDB | Replica set (primary + 2 secondaries) for HA; sharded cluster if >1TB |
| Redis | Replication for HA; cluster mode for >100GB |
| LiveKit | Multi-node with Redis coordination (separate from app Redis) |

**Target capacity per backend instance:**
- 2 vCPU, 4 GB RAM
- ~5,000 concurrent connections
- ~3,000 req/s steady state

### 8.3 Connection Pooling

| Resource | Pool Config |
|----------|-------------|
| MongoDB | `minPoolSize: 10, maxPoolSize: 100, maxIdleTimeMS: 60000` |
| Redis | `enableReadyCheck: true, maxRetriesPerRequest: 3, lazyConnect: false` |
| HTTP keep-alive | `keepAliveTimeout: 65000` (ALB sends RST after 60s; ours must outlive) |

### 8.4 Caching Strategy

| Data | Cache Layer | TTL | Invalidation |
|------|-------------|-----|--------------|
| User profile | Redis | 5 min | On profile update |
| Public user info (display name, avatar) | Redis | 30 min | On profile update |
| User contacts | Redis | 5 min | On contact change |
| Active call state | Redis | 1 hour | On state transition |
| Auth public keys (JWKS) | In-memory | 1 hour | Manual rotation |
| LiveKit room metadata | Redis | 30 min | Webhook events |

**Cache key conventions:** `{entity}:{id}:{field?}`. Use `mset` for bulk invalidation.

**Stampede protection:** `lock:{cacheKey}` with Redlock during cache rebuild.

### 8.5 Asynchronous Processing

Use **BullMQ** for jobs that don't need synchronous completion:

| Job | Reason |
|-----|--------|
| Push notifications | Don't block call initiate response |
| Email sending (password reset) | External API, can be slow |
| Call history aggregation | Background reporting |
| Webhook delivery to user systems (future) | Customer-facing reliability |
| Recording finalization | Long-running |

**Job retries:** Built-in exponential backoff. Failed jobs go to a dead-letter queue + alert.

### 8.6 Database Performance

- **Indexing:** Reviewed before every query merge; no slow queries (>100ms) in hot path
- **Aggregation pipelines:** Use indexes; avoid `$lookup` on large collections
- **Read replicas:** Hot reads (`call.history`, `user.profile`) prefer secondaries; writes always primary
- **Sharding plan:** Partition by `userId` if `users`/`calls` exceeds 100M docs

### 8.7 High Availability

**Backend:**
- Min 3 instances across 3 availability zones
- HPA: 3-50 instances, target 60% CPU
- Pod disruption budget: max 1 pod down during voluntary disruptions
- Liveness + readiness probes ensure unhealthy pods removed from rotation

**MongoDB:**
- Replica set with 3 nodes across 3 AZs
- Automated failover (~10-30s)
- Daily snapshots + PITR (Point-in-Time Recovery, 30 days)
- Tested DR drill quarterly: full restore to staging

**Redis:**
- Sentinel (3+ nodes) for automatic failover
- AOF + RDB persistence
- For huge scale: Redis Cluster (16384 slots, 6+ nodes)

**LiveKit:**
- 3+ nodes across regions
- Coordinated via Redis (separate cluster from app Redis)
- Dynamic node registration/deregistration

### 8.8 Multi-Region (Phase 3)

```
                         [Global DNS / Cloudflare]
                                 |
              +------------------+------------------+
              |                  |                  |
              v                  v                  v
        [US-East]            [EU-West]          [APAC]
              |                  |                  |
   +---+---+---+----+    +---+---+---+----+   +---+---+---+----+
   |Backend (3+)    |    |Backend (3+)    |   |Backend (3+)    |
   |LiveKit (3+)    |    |LiveKit (3+)    |   |LiveKit (3+)    |
   |Redis           |    |Redis           |   |Redis           |
   |MongoDB         |    |MongoDB         |   |MongoDB         |
   |(secondary)     |    |(secondary)     |   |(primary if EU) |
   +----------------+    +----------------+   +----------------+
              |                  |                  |
              +------------------+------------------+
                  Inter-region replication for MongoDB
                  (latency: 50-150ms, eventual consistency)
```

**Data residency:** GDPR users pinned to EU region; user data never leaves origin region except for cross-region replication for DR.

### 8.9 Capacity Planning Targets

| Metric | MVP | 1 year | 3 years |
|--------|-----|--------|---------|
| MAU | 10K | 250K | 2M |
| Concurrent calls | 100 | 2,500 | 20K |
| Backend instances | 3 | 10 | 30 |
| LiveKit nodes | 1 | 5 | 30 |
| MongoDB storage | 10 GB | 500 GB | 5 TB |
| Redis memory | 1 GB | 16 GB | 100 GB |

Load testing (k6 or Gatling) before each phase milestone.

### 8.10 Disaster Recovery

| Scenario | RTO | RPO | Strategy |
|----------|-----|-----|----------|
| Single instance failure | <30s | 0 | Auto-failover via load balancer |
| Single AZ outage | <2m | 0 | Multi-AZ deployment |
| Region outage | <30m | <5m | Multi-region DNS failover; secondary promoted |
| Database corruption | <1h | <15m | PITR restore from backup |
| Total infrastructure loss | <4h | <1h | IaC re-deploy + backup restore |

**RTO** = Recovery Time Objective; **RPO** = Recovery Point Objective.

---

## 9. Configuration & Secrets

### 9.1 Environment Variables

```bash
# Service
NODE_ENV=production
LOG_LEVEL=info
PORT=3000
SERVICE_NAME=agcloud-backend
SERVICE_VERSION=1.4.2

# Database
MONGODB_URI=mongodb://...                # secret
MONGODB_DB_NAME=agcloud

# Redis
REDIS_URL=redis://...                    # secret
REDIS_TLS=true

# Auth
JWT_SIGNING_KEY=...                      # secret, rotated 90 days
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# LiveKit
LIVEKIT_URL=https://livekit.agcloud.example.com
LIVEKIT_API_KEY=...                      # secret
LIVEKIT_API_SECRET=...                   # secret
LIVEKIT_WEBHOOK_API_KEY=...              # secret

# Push notifications
FCM_PROJECT_ID=...
FCM_PRIVATE_KEY=...                      # secret
APNS_KEY_ID=...
APNS_TEAM_ID=...
APNS_PRIVATE_KEY=...                     # secret
APNS_BUNDLE_ID=com.example.agcloud

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com
OTEL_TRACES_SAMPLER_ARG=0.1
PROMETHEUS_METRICS_ENABLED=true

# Email
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...                        # secret
SMTP_SECURE=false
SMTP_FROM=no-reply@agcloud.example.com
```

### 9.2 Configuration Validation

Validate all env vars at startup using **Zod**. Fail fast if invalid:
```javascript
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535),
  MONGODB_URI: z.string().url(),
  // ...
});
const config = ConfigSchema.parse(process.env);
```

### 9.3 Secret Storage

| Environment | Secret Storage |
|-------------|----------------|
| Local dev | `.env` (gitignored), `.env.example` committed |
| CI | GitHub Actions secrets / GitLab CI vars |
| Staging | AWS Secrets Manager / Vault |
| Production | AWS Secrets Manager / Vault, mounted via CSI driver in K8s |

---

## 10. Testing Strategy

### 10.1 Test Pyramid

| Layer | Coverage Target | Tools |
|-------|-----------------|-------|
| **Unit tests** | 80% of services, repos, utils | Vitest |
| **Integration tests** | All API routes, MongoDB + Redis interactions | Vitest + Testcontainers (real Mongo/Redis in Docker) |
| **Contract tests** | LiveKit SDK integration | Vitest with mocked LiveKit responses |
| **E2E tests** | Critical paths (signup → signin → call) | Playwright + real backend |
| **Load tests** | API endpoints, WebSocket scaling | k6, Gatling |
| **Security tests** | OWASP Top 10 | OWASP ZAP, Snyk, CodeQL |

### 10.2 Critical Test Scenarios

- **Auth:** signin success/failure, refresh rotation, refresh reuse detection, password reset flow
- **Calls:** 1:1 happy path, callee busy, callee offline (push fallback), call timeout, simultaneous initiation
- **Permissions:** non-participant cannot end call, non-owner cannot delete profile
- **Idempotency:** same `Idempotency-Key` returns same result
- **Rate limiting:** 6th signin attempt in 1m returns 429
- **Failure injection:** MongoDB down, Redis down, LiveKit down — verify graceful degradation

### 10.3 CI Pipeline

```
push -> lint (eslint, prettier) -> type-check (tsc) -> unit tests -> integration tests
     -> security scan (npm audit, Snyk) -> build container -> push to registry
     -> deploy to staging -> smoke tests -> manual approval -> deploy to production
```

Required checks before merge:
- All tests pass
- Coverage >= 80%
- No high/critical security vulnerabilities
- No TypeScript errors

---

## 11. Deployment

### 11.1 Container Image

- Base: `node:20-alpine` (multi-stage build)
- Non-root user (`USER node`)
- Read-only root filesystem (`readOnlyRootFilesystem: true`)
- Drop all capabilities except those explicitly needed
- Distroless variant for production where compatible

### 11.2 Resource Limits (Kubernetes)

```yaml
resources:
  requests: { cpu: "500m", memory: "512Mi" }
  limits:   { cpu: "2000m", memory: "2Gi" }
```

### 11.3 Probes

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 2

startupProbe:
  httpGet: { path: /health/live, port: 3000 }
  failureThreshold: 30
  periodSeconds: 10
```

### 11.4 Deployment Strategy

- **Rolling update** with `maxSurge: 25%, maxUnavailable: 0`
- **Canary** for major changes: 5% -> 25% -> 50% -> 100%, monitor error rate at each step
- **Automatic rollback** if error rate spikes >2x baseline within 10 minutes

### 11.5 Release Process

1. Tag commit with semantic version (`v1.4.2`)
2. CI builds + pushes container image
3. Helm/Argo CD deploys to staging
4. Smoke tests run automatically
5. Manual approval (PR comment / Slack button)
6. Canary rollout to production
7. Full rollout if metrics stable for 30 minutes

---

## Appendix A: Module Dependency Graph

```
            +---------------------+
            |      Routes         |
            |  (HTTP handlers)    |
            +----------+----------+
                       |
                       v
         +-------------+-------------+
         |         Services          |
         |  (business logic)         |
         |                           |
         |  AuthService              |
         |  UserService              |
         |  CallService              |
         |  LiveKitService           |
         |  NotificationService      |
         +-+---------+---------+-----+
           |         |         |
           v         v         v
      +--------+ +-------+ +-----------+
      |  Repos | | Cache | | External  |
      |(Mongo) | |(Redis)| | (LiveKit, |
      |        | |       | |  FCM/APNs)|
      +--------+ +-------+ +-----------+
```

## Appendix B: Reference Folder Structure

```
src/
  config/
    index.ts                # env validation, exports config
    constants.ts
  modules/
    auth/
      auth.routes.ts
      auth.service.ts
      auth.repository.ts
      auth.schemas.ts       # Zod
      auth.types.ts
    user/
      user.routes.ts
      user.service.ts
      user.repository.ts
      user.schemas.ts
    call/
      call.routes.ts
      call.service.ts
      call.repository.ts
      call.state-machine.ts
      call.schemas.ts
    livekit/
      livekit.routes.ts     # webhook
      livekit.service.ts    # SDK wrapper
      livekit.types.ts
    notification/
      notification.service.ts
      fcm.client.ts
      apns.client.ts
    health/
      health.routes.ts
  shared/
    middleware/
      auth.middleware.ts
      rate-limit.middleware.ts
      error-handler.ts
      request-id.ts
    db/
      mongo.client.ts
      redis.client.ts
    observability/
      logger.ts             # Pino
      metrics.ts            # prom-client
      tracing.ts            # OpenTelemetry
    security/
      jwt.ts
      argon2.ts
      crypto.ts
    utils/
      retry.ts              # p-retry wrapper
      circuit-breaker.ts    # opossum wrapper
      idempotency.ts
  app.ts                    # Fastify instance
  server.ts                 # entrypoint, graceful shutdown
test/
  unit/
  integration/
  e2e/
```
