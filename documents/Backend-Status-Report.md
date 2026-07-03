# agcloud Backend — Development Status Report

**Date:** July 3, 2026
**Branch reviewed:** `dev` (commit `b22d4cc`)
**Reference spec:** `documents/Backend-Specification.md`
**Prepared by:** Claude Code
**Previous report:** June 28, 2026 (commit `d9aaa22`)

---

## What Changed Since the Last Report

| Module | June 28 | July 3 | Change |
|---|---|---|---|
| Auth | 70% | 88% | argon2id migrated, rate limiting, error handler, GET /auth/me added |
| Call Lifecycle | 75% | 80% | Push notifications wired, GET /calls/:id added, missed state on end |
| LiveKit Integration | 50% | 90% | Webhook HMAC fixed, public URL fixed, participant_joined + egress_ended handlers |
| User / Contacts | 50% | 80% | PUT /users/me, /users/:id/presence, Redis-backed bulk presence |
| Realtime (Socket.IO) | 75% | 80% | Presence broadcasts now Redis pub/sub scoped per-instance |
| **Presence** | **Not tracked** | **90%** | **New full module — Redis-backed ONLINE/AWAY/OFFLINE with background worker** |
| Push Notifications | 0% | 90% | FCM v1, APNs + VoIP, device registration all implemented |
| Health / Admin | 65% | 70% | /metrics endpoint added (Prometheus format) |
| Security Infrastructure | 15% | 85% | Rate limiting, argon2id, helmet, CORS module, MongoDB indexes all done |
| Observability | 0% | 60% | Custom structured JSON logger, metrics, request ID propagation done |
| Reliability Utilities | 5% | 65% | Circuit breaker, retry, idempotency implemented (not yet wired) |
| Testing | 10% | 15% | cors.test.ts added |
| Infrastructure | Partial | 70% | docker-compose.yml restored; MongoDB indexes created on startup |

---

## Overall Progress at a Glance

| Module | Progress | Status |
|---|---|---|
| Auth | 88% | Functional and largely secure; refresh token rotation still incomplete |
| Call Lifecycle | 80% | Core flow solid; cancel, 60s timeout, callee-busy check still missing |
| LiveKit Integration | 90% | All critical bugs fixed; dev bypass acceptable for now |
| User / Contacts | 80% | Presence Redis-backed; contacts CRUD + blocklist still missing |
| Presence | 90% | Full Redis-backed presence with worker; not scoped to contacts only |
| Realtime (Socket.IO) | 80% | Solid; no rate limiting on WebSocket connections |
| Push Notifications | 90% | FCM + APNs + VoIP working; runs synchronously (no BullMQ queue) |
| Health / Admin | 70% | Metrics endpoint done; /live and /ready path mismatch remains |
| Security Infrastructure | 85% | All major items done; audit logging missing |
| Observability | 60% | Custom logger + metrics done; not Pino/prom-client; no OpenTelemetry |
| Reliability Utilities | 65% | Utilities built; none wired to actual external service calls |
| Testing | 15% | Auth + CORS tests only |
| Infrastructure | 70% | docker-compose.yml back; Dockerfile SSH artifact still present |

---

## What Is Working Today

The following can be tested end-to-end via Postman or the built-in WebRTC tester at `GET /calls/test`:

- User registration with **argon2id** password hashing
- Login / logout with 15-minute access token (httpOnly cookie)
- Opportunistic bcrypt → argon2id migration on next login
- Password forgot / reset flow
- Initiate a 1:1 or conference call → LiveKit room created, token + **public WebSocket URL** returned
- Real-time incoming call notification via Socket.IO **and push notification** (FCM Android / APNs iOS / VoIP PushKit)
- Accept / reject / end a call with proper Socket.IO events to all participants
- Re-invite a missed or rejected participant
- Start and stop call recording (LiveKit Egress)
- Call history with pagination (`GET /calls/history`)
- Register and unregister device push tokens (`POST /devices/register`, `DELETE /devices/:token`)
- User list with search, pagination, and **live Redis presence** (`GET /users`)
- Single user profile with live presence (`GET /users/:id`)
- Real-time per-user presence (`GET /users/:id/presence`)
- Bulk presence for all users (`GET /users/presence`)
- Update own profile (`PUT /users/me`)
- Health dashboard at `GET /` showing live Mongo / Redis / LiveKit status
- Liveness and readiness checks at `GET /live` and `GET /ready`
- Prometheus-format metrics at `GET /metrics`
- Webhook events from LiveKit (`room_finished`, `participant_joined`, `participant_left`, `egress_ended`) — **HMAC verified**

---

## Module Detail

### Auth Module — 88% (up from 70%)

| Endpoint / Feature | Status | Notes |
|---|---|---|
| `POST /auth/signup` | ✅ Done | argon2id — FIXED |
| `POST /auth/signin` | ✅ Done | 15-min cookie; bcrypt → argon2id migration on successful login |
| `POST /auth/signout` | ✅ Done | |
| `GET /auth/me` | ✅ Done | **New since last report** |
| `POST /auth/forgot-password` | ✅ Done | |
| `POST /auth/reset-password` | ✅ Done | |
| `POST /auth/refresh` | ⚠️ Partial | Accepts expired access token with `ignoreExpiration:true` and re-issues. `jwt.ts` has a proper `signRefreshToken / verifyRefreshToken` pair, but `auth.routes.ts` does not use it — two parallel implementations exist |
| Debug log leaking password hash | ✅ Fixed | All `console.log("<><>passwordHash")` lines removed |
| argon2id password hashing | ✅ Fixed | `argon2.ts` fully implemented — argon2id with bcrypt fallback for migration |
| Short-lived access tokens (15 min) | ✅ Fixed | Cookie `maxAge` = 900 s, token `expiresIn` = 15m |
| Rate limiting on login / signup | ✅ Fixed | 10 req / 15 min per IP via `@fastify/rate-limit` |
| Error handler (no stack trace leaks) | ✅ Fixed | `error-handler.ts` fully implemented |
| Refresh token rotation | ❌ Missing | `jwt.ts` infra exists but `auth.routes.ts` ignores it — no token revocation |
| Redis session blacklist | ❌ Missing | Stolen cookie is valid until expiry |
| Audit logging | ❌ Missing | No writes to `audit_logs` collection |

---

### Call Module — 80% (up from 75%)

| Endpoint / Feature | Status | Notes |
|---|---|---|
| `POST /calls/initiate` | ✅ Done | Emits `call:incoming` via Socket.IO **and** push notification to each receiver |
| `POST /calls/:id/accept` | ✅ Done | |
| `POST /calls/:id/reject` | ✅ Done | Conference per-participant; 1:1 full rejection |
| `POST /calls/:id/end` | ✅ Done | Marks pending invites as `missed` |
| `GET /calls/:id` | ✅ Done | **New since last report** |
| `GET /calls/history` | ✅ Done | Paginated |
| `POST /calls/:id/add-participant` | ✅ Done | Conference re-invite supported |
| `POST /calls/:id/record/start` | ✅ Done | LiveKit Egress |
| `POST /calls/:id/record/stop` | ✅ Done | |
| `missed` state on unanswered call | ⚠️ Partial | `markPendingParticipantsAsMissed` is called when the caller ends the call. There is no automatic 60-second timeout — a call stays `initiated` forever if the caller never hangs up |
| `POST /calls/:id/cancel` | ❌ Missing | Caller-side cancel before pickup |
| 60-second auto-timeout → missed | ❌ Missing | Requires BullMQ delayed job or Redis TTL — not implemented |
| Callee busy detection | ❌ Missing | Only checks if the **caller** is in an active call. Callee can receive a call invite while already in another call |
| Idempotency key on `POST /calls/initiate` | ❌ Missing | `idempotency.ts` utility exists but is not wired to any route |

---

### LiveKit Module — 90% (up from 50%)

All three critical bugs from previous reports are now fixed.

| Feature | Status | Notes |
|---|---|---|
| Token generation | ✅ Done | SDK v2 compatible |
| Room delete on call end | ✅ Done | |
| Egress (recording) start / stop | ✅ Done | |
| LiveKit health check | ✅ Done | |
| `POST /livekit/webhook` — HMAC | ✅ Fixed | `fastify-raw-body` registered; raw string passed to `receiver.receive()` |
| Public URL returned to clients | ✅ Fixed | `getLiveKitPublicUrl()` returns `LIVEKIT_PUBLIC_URL` (falls back to `LIVEKIT_URL`) |
| `room_finished` handler | ✅ Done | Auto-ends call, marks pending invites missed, emits `call:ended` |
| `participant_joined` handler | ✅ Done | **New** — transitions call from `initiated` → `active` |
| `participant_left` handler | ✅ Done | Ends 1:1 call when a participant leaves |
| `egress_ended` handler | ✅ Done | **New** — saves `recordingUrl` to call document |
| No-auth-header dev bypass | ⚠️ Acceptable | Allowed in non-production only; production rejects requests without `Authorization` |
| `room_started` event handler | ❌ Missing | Not required for current flow |

---

### Presence Module — 90% (New)

Entirely new Redis-backed presence system added since the last report.

| Feature | Status | Notes |
|---|---|---|
| Redis hash per user (`presence:user:{id}`) | ✅ Done | Stores `status`, `lastActivity`, `lastHeartbeat`, `lastSeen` |
| Socket set per user (`:sockets`) | ✅ Done | Tracks active socket IDs for multi-device support |
| Grace period on disconnect (`:grace`, 30s TTL) | ✅ Done | Prevents flicker on mobile app backgrounding |
| `ONLINE / AWAY / OFFLINE` status derivation | ✅ Done | ONLINE = activity < 2 min; AWAY = socket open; OFFLINE = no socket + stale > 10 min |
| Startup socket cleanup | ✅ Done | Clears all stale socket sets on restart so users aren't stuck as ONLINE |
| Background evaluation worker (60s interval) | ✅ Done | Applies ONLINE→AWAY and →OFFLINE transitions |
| MongoDB DB sync worker (5 min interval) | ✅ Done | Persists Redis status to `users.presenceStatus` |
| Redis pub/sub fan-out (`presence:broadcast`) | ✅ Done | Cross-instance broadcast; subscribers emit to Socket.IO |
| Activity middleware (global HTTP hook) | ✅ Done | Updates `lastActivity` after every authenticated request (throttled 30s) |
| Heartbeat handler | ✅ Done | Updates `lastHeartbeat` on WebSocket PING |
| Presence scoped to contacts only | ❌ Missing | `io.emit(event, ...)` sends presence updates to **all** connected sockets, not just the user's contacts |
| Rate limiting on WebSocket connections | ❌ Missing | |

---

### User Module — 80% (up from 50%)

| Endpoint / Feature | Status | Notes |
|---|---|---|
| `GET /users` (list, search, pagination) | ✅ Done | Live Redis presence enriched via batch pipeline |
| `GET /users/presence` (bulk) | ✅ Done | **Redis-backed** — fixed from MongoDB-only in last report |
| `GET /users/:id` | ✅ Done | |
| `GET /users/:id/presence` | ✅ Done | **New** — Redis source of truth with MongoDB `lastSeen` fallback |
| `GET /auth/me` | ✅ Done | **New** — current user profile endpoint |
| `PUT /users/me` | ✅ Done | **New** — `displayName` and `avatarUrl` update |
| `GET /users/me/contacts` | ❌ Missing | |
| `POST/DELETE /users/me/contacts/:id` | ❌ Missing | |
| `POST /users/me/block/:id` | ❌ Missing | `isBlocked` field exists in schema but nothing sets it |

---

### Notification Module — 90% (up from 0%)

| Feature | Status | Notes |
|---|---|---|
| FCM v1 (Android / Web) | ✅ Done | OAuth2 service-account token; auto-refreshed 1 min before expiry |
| APNs (iOS alerts) | ✅ Done | JWT auth, sandbox/production toggle |
| VoIP push (PushKit) | ✅ Done | `pushType: "voip"`, zero expiration |
| `POST /devices/register` | ✅ Done | Upserts by `(userId, platform, token)`; stores optional `voipToken` |
| `DELETE /devices/:token` | ✅ Done | |
| `notifyIncomingCall` | ✅ Done | Wired into `POST /calls/initiate` |
| `notifyMissedCall` | ✅ Done | Defined but not yet called (no 60s timeout trigger) |
| Metrics (`push_notifications_sent/failed`) | ✅ Done | Labelled by platform |
| Asynchronous delivery (BullMQ) | ❌ Missing | Push calls run synchronously in the HTTP handler; a slow/failed FCM/APNs call delays the response |

---

### Realtime Module — 80% (up from 75%)

| Feature | Status | Notes |
|---|---|---|
| Socket.IO server with JWT auth | ✅ Done | |
| `emitToUser(userId, event, payload)` | ✅ Done | Routes to all active sockets for a user |
| Multi-device support | ✅ Done | |
| Re-notify pending calls on reconnect | ✅ Done | |
| Presence via Redis pub/sub | ✅ Done | Presence events now routed through Redis pub/sub instead of direct `io.emit` |
| Presence scoped to contacts | ❌ Missing | All connected users receive all presence events |
| Rate limiting on socket connections | ❌ Missing | |

---

### Health Module — 70% (up from 65%)

| Feature | Status | Notes |
|---|---|---|
| HTML health dashboard at `GET /` | ✅ Done | |
| `GET /live` (liveness) | ✅ Done | |
| `GET /ready` (readiness) | ✅ Done | Checks MongoDB, Redis, LiveKit |
| `GET /metrics` (Prometheus format) | ✅ Done | **New** — custom in-memory counter/histogram format |
| `/health/live` and `/health/ready` paths | ❌ Path mismatch | `healthRoutes` registered without prefix in `app.ts` — still at `/live` and `/ready`. K8s probes expect `/health/*` |
| `GET /admin/calls/active` | ❌ Missing | |

---

### Security Infrastructure — 85% (up from 15%)

| Feature | Status | Notes |
|---|---|---|
| JWT auth middleware | ✅ Done | |
| `@fastify/cors` with origin allowlist | ✅ Done | `cors.ts` module; also allows `localhost` and `*.devtunnels.ms` in dev |
| `@fastify/cookie` | ✅ Done | |
| `@fastify/helmet` (security headers) | ✅ Fixed | CSP + HSTS enabled in production only |
| argon2id hashing | ✅ Fixed | Full implementation with bcrypt migration path |
| `crypto.ts` (secure token, hash, safe compare) | ✅ Done | |
| `jwt.ts` (signAccessToken + signRefreshToken) | ✅ Done | Infrastructure present; `auth.routes.ts` has its own parallel `signToken` and doesn't use these |
| Global rate limiting | ✅ Fixed | 200 req/min global; 10 req/15 min on auth endpoints |
| Error handler | ✅ Fixed | |
| MongoDB indexes | ✅ Fixed | `ensureIndexes()` called on startup: `users.email` unique, call status, room ID, egress ID, device unique |
| Redis session blacklist | ❌ Missing | |
| Audit logging | ❌ Missing | |

---

### Observability — 60% (up from 0%)

| Feature | Status | Notes |
|---|---|---|
| Structured JSON logger | ✅ Done | Custom implementation writing JSON to stdout/stderr; respects `LOG_LEVEL` env var |
| Pino integration | ⚠️ Partial | `pino` is in `package.json` but unused — Fastify's built-in pino instance is configured, while the custom logger is used everywhere else |
| Prometheus-format metrics at `/metrics` | ✅ Done | Custom in-memory counters/histograms for HTTP, calls, push; not `prom-client` |
| Request ID propagation | ✅ Done | `X-Request-ID` header honoured and echoed; attached to request logger |
| OpenTelemetry distributed tracing | ❌ Missing | `tracing.ts` is a lightweight request ID hook only — no spans, no trace propagation |
| PII redaction in logs | ✅ Done | No sensitive fields logged (password hash log removed) |

---

### Reliability Utilities — 65% (up from 5%)

| Feature | Status | Notes |
|---|---|---|
| Graceful shutdown (SIGTERM / SIGINT) | ✅ Done | Stops presence worker, closes Redis, closes Fastify |
| Redis error handling + reconnect | ✅ Done | |
| `circuit-breaker.ts` | ✅ Done | Full CLOSED/OPEN/HALF_OPEN state machine with timeout support |
| `retry.ts` | ✅ Done | Exponential backoff with jitter |
| `idempotency.ts` | ✅ Done | Redis-backed; `withIdempotency` wrapper available |
| Circuit breakers wired to external calls | ❌ Missing | None of LiveKit, FCM, or APNs calls use `CircuitBreaker.execute()` |
| Retry wired to external calls | ❌ Missing | `withRetry` built but not used |
| Idempotency wired to mutating routes | ❌ Missing | `withIdempotency` built but not applied to `/calls/initiate` or other routes |
| BullMQ async job queue | ❌ Missing | Push notifications are synchronous in HTTP handlers |

---

### Testing — 15% (up from 10%)

| Area | Status |
|---|---|
| Auth routes test (`test/auth.routes.test.ts`) | ✅ Done |
| CORS test (`test/cors.test.ts`) | ✅ Done — **New** |
| Call module tests | ❌ Missing |
| User module tests | ❌ Missing |
| Presence module tests | ❌ Missing |
| Notification module tests | ❌ Missing |
| LiveKit module tests | ❌ Missing |
| Integration tests (real Mongo + Redis) | ❌ Missing |

---

### Infrastructure — 70% (up from Partial)

| Item | Status | Notes |
|---|---|---|
| `docker-compose.yml` | ✅ Restored | **Was missing in last report** |
| MongoDB indexes on startup | ✅ Done | **New** — `ensureIndexes()` called from `server.ts`; indexes users, calls, devices |
| `.env.example` | ✅ Done | Includes `LIVEKIT_PUBLIC_URL`, all FCM/APNs vars |
| `Dockerfile` | ⚠️ Bug | Lines 17–18 still contain developer SSH key paths (`/c/Users/venkat/.ssh/id_ed25519`). Remove them. |
| Helm chart templates | ❌ Stubs | Files exist, all content empty |

---

## Remaining Bugs

### Bug 1 — SSH Key Artifact in Dockerfile (lines 17–18)
```
/c/Users/venkat/.ssh/id_ed25519
ssh-add $env:venkat\.ssh\id_ed25519
```
Harmless at runtime but suggests credentials were meant to be baked into the image. Remove before any shared CI or image registry.

### Bug 2 — Health Route Path Mismatch
`healthRoutes` is registered in `app.ts` without a prefix, so `/live` and `/ready` are at the server root. Standard K8s probes and the spec expect `/health/live` and `/health/ready`.

**Fix:** Change `app.register(healthRoutes)` → `app.register(healthRoutes, { prefix: "/health" })`.

### Bug 3 — Callee Busy Detection Missing
`POST /calls/initiate` checks if the **caller** is in an active call but not the callees. A user already in a call will receive a second incoming call ring.

**Fix:** Loop over `receiverIds` and call `callRepo.getActiveCallForUser(receiverId)` before creating the call record. Return 409 if any callee is busy.

### Bug 4 — Dual `signToken` Implementation
`jwt.ts` defines `signAccessToken` (15 min) and `signRefreshToken` (7 days with `jwtRefreshSecret`). `auth.routes.ts` has its own `signToken` function using `jwtSecret` and does **not** use either of these. The refresh endpoint (`POST /auth/refresh`) validates the access token with `ignoreExpiration: true` — it is not using the separate refresh token infrastructure.

**Fix:** Replace `signToken` in `auth.routes.ts` with `signAccessToken` from `jwt.ts`, and replace the refresh logic with `signRefreshToken` / `verifyRefreshToken`.

### Bug 5 — Push Notifications Are Synchronous
`notifyIncomingCall` is `await`-ed inside `POST /calls/initiate`. A slow or failed FCM/APNs call adds latency to the caller's response. A network timeout to Google's FCM API could block the endpoint for seconds.

**Fix (short-term):** Change to fire-and-forget: `.catch(err => logger.warn(...))` without `await`. **Fix (proper):** Move to BullMQ queue.

### Bug 6 — Presence Not Scoped to Contacts
Redis pub/sub subscriber emits presence events via `io.emit(event, ...)`, which broadcasts to every connected socket regardless of whether users know each other.

**Fix:** Replace with `io.to(room).emit(...)` where rooms are per-contact-pair, or filter at client subscription time.

---

## Recommended Next Steps

### Immediate (before any demo with real devices)

1. Fix Dockerfile SSH artifact (Bug 1)
2. Fix health route path (Bug 2) — one-line change in `app.ts`
3. Make push notifications fire-and-forget to unblock caller (Bug 5 short-term)
4. Wire `jwt.ts` into `auth.routes.ts` to use the proper refresh token path (Bug 4)

### Sprint Continuation

5. **Callee busy detection** — `POST /calls/initiate` guard (Bug 3)
6. **60-second call timeout** — add a Redis key with TTL on call creation; a BullMQ job or presence worker sweep marks it `missed` and fires `notifyMissedCall`
7. **`POST /calls/:id/cancel`** — caller cancels before pickup; emits `call:cancelled` to receivers
8. **Wire reliability utilities** — apply `CircuitBreaker` to LiveKit and push notification calls; apply `withRetry` to FCM; apply `withIdempotency` to `POST /calls/initiate`
9. **Contacts CRUD** — `GET/POST/DELETE /users/me/contacts`
10. **Blocklist** — `POST /users/me/block/:id` and wire into call permission checks

### Production Hardening

11. Scope presence to contacts only (Bug 6)
12. Migrate logger to native Pino (remove custom logger; use Fastify's built-in pino instance everywhere)
13. Replace custom metrics with `prom-client` for native Prometheus pull
14. Add OpenTelemetry SDK (`@opentelemetry/sdk-node`) for distributed tracing
15. Add BullMQ for async push / email jobs
16. Integration test suite — at minimum cover call lifecycle and presence module

---

## Architecture Note — Empty Service Files

The following files remain as 1-line empty stubs. Business logic currently lives directly in route handlers, which matches the working code but contradicts the spec's three-layer design:

- `src/modules/auth/auth.service.ts`
- `src/modules/auth/auth.repository.ts`
- `src/modules/auth/auth.types.ts`
- `src/modules/call/call.service.ts`
- `src/modules/user/user.service.ts`
- `src/modules/livekit/livekit.types.ts`
- `src/config/constants.ts`

The routes-only approach is functionally fine for the current scale. Filling in service files would make unit testing significantly easier and is recommended before the test coverage push.

---

## Open Questions

1. **Vipin:** `auth.routes.ts` still has its own `signToken` function rather than using `signAccessToken` from `jwt.ts`. Is the plan to unify these, or keep them separate? The refresh token path in `jwt.ts` is currently dead code.

2. **Vipin:** Push notifications in `POST /calls/initiate` are `await`-ed synchronously. Before the 60-second timeout feature is added, can they be made fire-and-forget so a slow FCM/APNs response doesn't slow down the caller?

3. **Nishant:** The `url` field in `POST /calls/initiate` and `POST /calls/:id/accept` responses now returns `LIVEKIT_PUBLIC_URL` correctly. Please confirm that the frontend is consuming this field (not hardcoding the LiveKit URL) so the fix takes effect.

4. **All:** Health probes are still at `/live` and `/ready`. If Kubernetes is already configured with `/health/live` probes, the pods are currently failing readiness checks silently. Should we fix the prefix or update the probe config?
