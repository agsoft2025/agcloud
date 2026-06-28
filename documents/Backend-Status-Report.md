# agcloud Backend — Development Status Report

**Date:** June 28, 2026
**Branch reviewed:** `dev` (commit `d9aaa22`)
**Reference spec:** `documents/Backend-Specification.md`
**Prepared by:** Claude Code
**Previous report:** June 13, 2026 (commit `69adcff`)

---

## What Changed Since the Last Report

| Module | Before (June 13) | Now (June 28) | Change |
|---|---|---|---|
| Auth | 70% | 70% | No change |
| Call Lifecycle | 60% | 75% | History, add-participant, conference mode, re-invite added |
| LiveKit Integration | 50% | 50% | No change — critical bugs still open |
| User / Contacts | 10% | 50% | Routes and repository now implemented |
| **Realtime (Socket.IO)** | **Not tracked** | **75%** | **New module — full presence + event routing** |
| Push Notifications | 0% | 0% | No change |
| Health / Admin | 40% | 65% | `/live` and `/ready` endpoints added |
| Security Infrastructure | 15% | 15% | No change |
| Observability | 0% | 0% | No change |
| Testing | 10% | 10% | No change |

---

## Overall Progress at a Glance

| Module | Progress | Status |
|---|---|---|
| Auth | 70% | Functional but insecure — 7-day non-revocable tokens, no refresh token system |
| Call Lifecycle | 75% | Core flow + conference + history work; no push = cannot ring real devices |
| LiveKit Integration | 50% | Token/room working; webhook HMAC still broken; wrong URL returned |
| User / Contacts | 50% | List, search, presence implemented; `/users/me`, contacts, blocklist missing |
| Realtime (Socket.IO) | 75% | Full presence tracking and event routing; one privacy gap |
| Push Notifications | 0% | All three files still empty — blocking real-device testing |
| Health / Admin | 65% | HTML dashboard + `/live` + `/ready` done; Prometheus missing; wrong path |
| Security Infrastructure | 15% | Auth middleware done; rate limit / helmet / argon2 still missing |
| Observability | 0% | Logger, metrics, tracing all empty stubs |
| Testing | 10% | Auth tests only |

---

## What Is Working Today

The following can be tested end-to-end via Postman or the built-in WebRTC tester at `GET /calls/test`:

- User registration and login (cookie-based JWT)
- Password forgot / reset flow
- Initiate a 1:1 or conference call → generates a LiveKit room and returns a token
- Real-time incoming call notification to online users via Socket.IO
- Accept a call → returns callee token; notifies caller via Socket.IO
- Reject / end a call → notifies all participants via Socket.IO
- Add a participant to an ongoing call (converts to conference)
- Re-invite a missed/rejected participant
- Start and stop call recording (LiveKit Egress)
- Call history with pagination (`GET /calls/history`)
- User list with search and pagination (`GET /users`)
- User presence (online/offline via Socket.IO, `/users/presence` for bulk)
- Health dashboard at `GET /` showing Mongo / Redis / LiveKit status
- Health checks at `GET /live` and `GET /ready`

---

## Module Detail

### Auth Module — 70% (no change)

| Endpoint / Feature | Status | Notes |
|---|---|---|
| `POST /auth/signup` | ✅ Done | |
| `POST /auth/signin` | ✅ Done | Sets httpOnly cookie |
| `POST /auth/signout` | ✅ Done | Clears cookie |
| `POST /auth/forgot-password` | ✅ Done | Reset token hashed in DB |
| `POST /auth/reset-password` | ✅ Done | Expiry validated |
| `POST /auth/refresh` | ⚠️ Partial | Accepts expired JWT, re-signs it. NOT a real refresh token system — no rotation, no revocation |
| Refresh token rotation | ❌ Missing | Spec requires separate opaque refresh tokens stored hashed in DB |
| Short-lived access tokens (15 min) | ❌ Missing | Currently 7 days — a stolen cookie is valid for 7 days |
| Redis session blacklist | ❌ Missing | Cannot revoke a signed-in session |
| argon2id password hashing | ❌ Missing | Using bcrypt; `argon2.ts` is an empty file |
| Rate limiting on login attempts | ❌ Missing | Brute-force unprotected |
| Audit logging | ❌ Missing | No writes to `audit_logs` collection |

**Bug (critical — must fix before demo):** `auth.routes.ts` lines 134, 137, 146, 158 log raw request body, user record, password hash, and insert result to stdout: `console.log("<><>passwordHash", passwordHash)`. These must be removed before any shared environment.

---

### Call Module — 75% (up from 60%)

Core call flow is solid. Conference mode and call history were added since the last report.

| Endpoint / Feature | Status | Notes |
|---|---|---|
| `POST /calls/initiate` | ✅ Done | Creates LiveKit room, returns token, emits `call:incoming` via Socket.IO |
| `POST /calls/:id/accept` | ✅ Done | Returns callee token, emits accepted/joined events |
| `POST /calls/:id/reject` | ✅ Done | Per-participant for conference; full rejection for 1:1 |
| `POST /calls/:id/end` | ✅ Done | Deletes LiveKit room, marks pending invites as missed |
| `GET /calls/:id` | ✅ Done | Authorization checked |
| `GET /calls/history` | ✅ Done | Paginated, sorted by `createdAt` desc — **was listed as missing in last report** |
| `POST /calls/:id/add-participant` | ✅ Done | **New since last report** — adds user to in-progress call, re-invite supported |
| `POST /calls/:id/record/start` | ✅ Done | LiveKit Egress |
| `POST /calls/:id/record/stop` | ✅ Done | |
| Conference mode | ✅ Done | **New since last report** — `callMode: "conference"`, per-participant status tracking |
| Re-invite (previously missed/rejected) | ✅ Done | **New since last report** — resets participant status to "invited" |
| `POST /calls/:id/cancel` | ❌ Missing | Caller-side cancel before pickup |
| Push notification to callee | ❌ Missing | **Highest priority blocker** — callee only notified if they are online via Socket.IO |
| Callee busy detection | ❌ Missing | Only the **caller's** active call is checked. If callee is already in a call, the invite is silently sent and they get a second incoming call ring |
| Call timeout (unanswered → missed) | ❌ Missing | No timer or scheduled job; calls stay in `initiated` forever |
| Idempotency key | ❌ Missing | `idempotency.ts` is an empty file |

---

### LiveKit Module — 50% (no change)

Token generation and room management are solid. The two bugs from the last report are **still open**.

| Feature | Status | Notes |
|---|---|---|
| Token generation (`toJwt()` awaited) | ✅ Done | SDK v2 compatible |
| Room delete on call end | ✅ Done | Graceful 404 handling |
| Egress (recording) start / stop | ✅ Done | |
| LiveKit health check | ✅ Done | |
| `POST /livekit/webhook` | ⚠️ Broken | Fastify parses body as JSON before HMAC verification — signature always fails in production |
| Webhook no-auth-header bypass | ❌ Security gap | If `Authorization` header is absent, falls back to unverified body in all environments (line: `event = request.body`) |
| Public LiveKit URL for clients | ❌ Wrong | `getLiveKitBaseUrl()` returns `config.livekitUrl` (e.g. `http://livekit:7880`). Browsers cannot reach this Docker-internal address |
| `room_started` event handler | ❌ Missing | |
| `participant_joined` → state to active | ❌ Missing | Call goes to `active` via `POST /calls/:id/accept`, not via webhook |
| `egress_ended` → save recording URL | ❌ Missing | |

**Fix required:** Add `@fastify/rawbody` plugin to Fastify and pass the raw string to `receiver.receive()`. Also add `LIVEKIT_PUBLIC_URL` to `.env.example` and `config/index.ts`, then return that from `getLiveKitBaseUrl()` instead of `config.livekitUrl`.

---

### Realtime Module — 75% (new — not tracked in last report)

Full Socket.IO implementation added since the last report. This is the mechanism by which online users receive incoming call events in lieu of push notifications.

| Feature | Status | Notes |
|---|---|---|
| Socket.IO server with JWT auth | ✅ Done | Token accepted via `auth.token` or `Authorization: Bearer` |
| Presence tracking (`online` / `offline`) | ✅ Done | Written to MongoDB on connect/disconnect; persists across server restarts |
| `emitToUser(userId, event, payload)` | ✅ Done | Routes to all active sockets for a given user |
| Multi-device support | ✅ Done | `userSockets` map holds a Set of socket IDs per user |
| Re-notify pending calls on reconnect | ✅ Done | On user connect, fetches active calls they haven't answered and re-sends `call:incoming` |
| `presence:update` broadcast | ⚠️ Privacy gap | `io.emit("presence:update", ...)` broadcasts to **all connected users**, not just contacts. Every user learns the online status of every other user |
| Rate limiting on socket connections | ❌ Missing | Unauthenticated or abusive clients can hammer the WS endpoint |

---

### User Module — 50% (up from 10%)

Routes and repository were implemented since the last report.

| Feature | Status | Notes |
|---|---|---|
| `GET /users` (list with search + pagination) | ✅ Done | Filters suspended/deleted/blocked users; search across name, email, phone, extension |
| `GET /users/presence` (bulk) | ✅ Done | Returns all users' presence status from MongoDB |
| `GET /users/:id` | ✅ Done | Returns public profile |
| `GET /users/me` | ❌ Missing | No "current user" profile endpoint |
| `PATCH /users/me` | ❌ Missing | No profile editing |
| `GET /users/me/contacts` | ❌ Missing | No contact list management |
| `POST /users/me/contacts` | ❌ Missing | |
| `DELETE /users/me/contacts/:id` | ❌ Missing | |
| `POST /users/me/block/:id` | ❌ Missing | No blocklist; `isBlocked` field exists in schema but nothing sets it |
| `GET /users/:id/presence` (Redis, per-user) | ❌ Missing | Spec requires Redis-backed per-user presence query |
| Presence backed by Redis | ❌ Missing | Presence is stored in MongoDB, not Redis. Spec requires Redis for sub-millisecond reads |

---

### Notification Module — 0% (no change)

All three files (`fcm.client.ts`, `apns.client.ts`, `notification.service.ts`) are still empty.

| Feature | Status |
|---|---|
| FCM push (Android / Web) | ❌ Not started |
| APNs push (iOS) | ❌ Not started |
| VoIP push / PushKit (iOS call ringing) | ❌ Not started |
| `POST /devices/register` | ❌ Not started |
| `DELETE /devices/:tokenId` | ❌ Not started |
| `devices` MongoDB collection + schema | ❌ Not started |

**This is the highest-priority missing feature.** Without push notifications, calls only ring for users who are already connected to the Socket.IO server. Any user with a closed browser or a mobile app in the background will never receive the call.

---

### Health Module — 65% (up from 40%)

| Feature | Status | Notes |
|---|---|---|
| HTML health dashboard at `GET /` | ✅ Done | Shows live status of Mongo / Redis / LiveKit |
| `GET /live` (JSON liveness) | ✅ Done | **Was listed as missing in last report** |
| `GET /ready` (JSON readiness) | ✅ Done | **Was listed as missing in last report** — checks MongoDB, Redis, LiveKit |
| `GET /metrics` (Prometheus) | ❌ Missing | `metrics.ts` is empty |
| `GET /admin/calls/active` | ❌ Missing | |
| Correct path prefix | ⚠️ Mismatch | Routes are registered at `/live` and `/ready` (no prefix in `app.ts`). Spec and Kubernetes probes expect `/health/live` and `/health/ready` |

**Fix required:** Either register healthRoutes with `{ prefix: "/health" }` in `app.ts`, or update K8s probe config to match the current `/live` and `/ready` paths.

---

### Security Infrastructure — 15% (no change)

| Feature | Status | Notes |
|---|---|---|
| `auth.middleware.ts` (JWT cookie / Bearer) | ✅ Done | Applied to all protected routes |
| `@fastify/cors` | ✅ Done | Origin allowlist in production |
| `@fastify/cookie` | ✅ Done | |
| `argon2.ts` | ❌ Empty | Still using bcrypt — switch before first production user |
| `jwt.ts` / `crypto.ts` | ❌ Empty | |
| `rate-limit.middleware.ts` | ❌ Empty | Signup, signin, initiate call are all unprotected |
| `error-handler.ts` | ❌ Empty | Unhandled errors can leak stack traces |
| `@fastify/helmet` | ❌ Not installed | No security headers (CSP, HSTS, X-Frame-Options) |
| MongoDB indexes | ❌ Missing | `users.email`, `calls.status`, `calls.participants.userId` — all unindexed |

---

### Observability — 0% (no change)

| Feature | Status |
|---|---|
| Structured logging / Pino (`logger.ts`) | ❌ Empty — `console.log` used throughout |
| Prometheus metrics (`metrics.ts`) | ❌ Empty |
| OpenTelemetry tracing (`tracing.ts`) | ❌ Empty |
| Request ID propagation (`request-id.ts`) | ❌ Empty |
| PII redaction in logs | ❌ Missing — password hash currently logged in plaintext |

---

### Reliability Utilities — Partial (no change)

| Feature | Status |
|---|---|
| Graceful shutdown (SIGTERM / SIGINT) | ✅ Done |
| Redis error handling + reconnect | ✅ Done |
| `circuit-breaker.ts` | ❌ Empty |
| `retry.ts` | ❌ Empty |
| `idempotency.ts` | ❌ Empty |
| BullMQ async job queue (push, email) | ❌ Not started |

---

### Testing — 10% (no change)

| Area | Status |
|---|---|
| `vitest.config.ts` | ✅ Done |
| Auth routes test (`test/auth.routes.test.ts`, 164 lines) | ✅ Done |
| Call module tests | ❌ Missing |
| User module tests | ❌ Missing |
| Realtime / Socket.IO tests | ❌ Missing |
| LiveKit module tests | ❌ Missing |
| Integration tests (real Mongo + Redis) | ❌ Missing |

---

### Infrastructure — Partial (no change)

| Item | Status | Notes |
|---|---|---|
| `Dockerfile` | ⚠️ Bug | Lines 17-18 contain leaked SSH key paths (`/c/Users/venkat/.ssh/id_ed25519`) — must be removed |
| `.env.example` | ✅ Present | At repo root |
| `docker-compose.yml` | ❌ Missing | Still removed; developers have no local infrastructure stack |
| Helm chart templates | ❌ Stubs | Files exist, all content is empty |

---

## Critical Bugs to Fix Before Any Demo

These were in the last report and remain open:

1. **Debug logs leaking sensitive data** (`auth.routes.ts` lines 134, 137, 146, 158) — `console.log("<><>passwordHash", ...)` prints bcrypt hash to stdout. Remove all `<><>` debug lines.

2. **Webhook HMAC always fails** — Fastify pre-parses the body as JSON before `receiver.receive()` runs. Add `@fastify/rawbody` and pass the raw string. Without this fix, LiveKit events are silently ignored in production.

3. **Wrong LiveKit URL returned to clients** — `getLiveKitBaseUrl()` returns the internal `LIVEKIT_URL` (e.g. `http://livekit:7880`). Add `LIVEKIT_PUBLIC_URL` env var (e.g. `wss://livekit.agcloud.example.com`) and return that instead.

New bugs found in this review:

4. **Callee busy not checked** — `POST /calls/initiate` only checks if the **caller** is in an active call. If the callee is already in a call, their device is still sent a `call:incoming` event and the call record is created. Add `getActiveCallForUser` check for each `receiverId` before creating the call.

5. **Presence broadcast is public** — `realtime.service.ts` line 54 uses `io.emit("presence:update", ...)` which broadcasts to every connected socket. Every user can watch every other user come online or go offline. This should be scoped to contacts-only or use per-room filtering.

6. **SSH key artifact in Dockerfile** — Lines 17-18 contain `ssh-add` commands with an absolute Windows path. These do nothing at runtime but are noise and suggest credentials may have been intended to be baked into the image at some point. Remove them.

7. **Health route path mismatch** — Routes registered at `/live` and `/ready` but spec and standard K8s probe config expects `/health/live` and `/health/ready`. Fix by adding prefix to registration in `app.ts`.

---

## Recommended Sprint Priorities

### Sprint 1 — Fix blockers, enable real-device testing

1. Fix the 7 bugs listed above (bugs 1-7)
2. Build notification module: FCM (Android/web), APNs VoIP (iOS)
3. `POST /devices/register` + `DELETE /devices/:tokenId` + `devices` schema
4. Wire FCM/APNs into `POST /calls/initiate` alongside Socket.IO emit
5. Add `missed` state + 60-second call timeout (BullMQ delayed job or Redis TTL)
6. `POST /calls/:id/cancel` endpoint

### Sprint 2 — Complete the user experience

1. `GET /users/me` and `PATCH /users/me`
2. Contacts management (`GET/POST/DELETE /users/me/contacts`)
3. Blocklist (`POST /users/me/block/:id`) — wire `isBlocked` into call permission checks
4. Scope presence broadcasts to contacts only
5. Refresh token system: 15-min access token + 7-day opaque refresh token stored hashed in DB

### Sprint 3 — Harden for production

1. Rate limiting (`@fastify/rate-limit` or `rate-limiter-flexible`) on auth and call endpoints
2. Replace bcrypt with argon2id
3. `@fastify/helmet`
4. MongoDB indexes (at minimum: `users.email` unique, `calls.status`, `calls.participants.$userId`)
5. `error-handler.ts` — RFC 7807 error responses, no stack traces in production

### Sprint 4 — Observability and reliability

1. Pino structured logging with PII redaction (replace all `console.log` calls)
2. Prometheus metrics endpoint (`GET /metrics`)
3. OpenTelemetry tracing
4. Circuit breakers on LiveKit, FCM, APNs
5. BullMQ for async push / email jobs
6. Integration test suite (real Mongo + Redis via Docker or Testcontainers)
7. Restore `docker-compose.yml` for local development

---

## Open Questions

1. **Vipin (Backend):** The `auth.service.ts`, `auth.repository.ts`, `call.service.ts`, and `user.service.ts` files are all empty stubs. Business logic is currently written directly in route handlers. Is the plan to keep routes as the only layer, or should these service files be filled in? The spec shows a three-layer architecture (routes → services → repositories).

2. **Vipin (Backend):** Presence is currently stored in MongoDB (`presenceStatus` + `lastSeenAt`). The spec requires Redis for presence (sub-millisecond reads, 90s heartbeat TTL). Should we migrate, or is MongoDB acceptable for the current scale?

3. **Nishant (Frontend):** `POST /calls/initiate` and `POST /calls/:id/accept` still return `url: getLiveKitBaseUrl()` which resolves to the Docker-internal URL. Is the frontend hardcoding the LiveKit WebSocket URL, or consuming it from the API response?

4. **Ajay / Venkat:** Push notification module is 0% and is blocking real-device testing. Should this be the top priority for the next sprint, or is browser-only testing via Socket.IO sufficient for now?

5. **All:** `docker-compose.yml` was removed on the dev branch and never restored. Developers need a way to run Mongo, Redis, and LiveKit locally. Should it be restored, or is there a documented alternative?
