# agcloud Backend — Development Status Report

**Date:** July 10, 2026
**Branch reviewed:** `dev` (commit `4f87837`)
**Reference spec:** `documents/Backend-Specification.md`
**Prepared by:** Claude Code
**Previous report:** July 3, 2026 (commit `b22d4cc` / feature/authtoken merge)

---

## Activity Since Last Report

No source code commits landed on `dev` between July 3 and July 10. The only commit (`4f87837 Updated Status Report`) was the July 3 report document itself. All module statuses are unchanged from last week.

One correction to the July 3 report: **Bug 5 ("push notifications are synchronous") was incorrect.** The `notifyIncomingCall` call in `POST /calls/initiate` already uses fire-and-forget with `.catch()` — it does not block the HTTP response. That item has been removed from the open bug list.

---

## Overall Progress at a Glance

| Module | Progress | Status |
|---|---|---|
| Auth | 88% | Functional and secure; refresh token rotation still incomplete |
| Call Lifecycle | 80% | Core flow solid; cancel, 60s timeout, callee-busy check still missing |
| LiveKit Integration | 90% | All critical bugs resolved |
| User / Contacts | 80% | Presence Redis-backed; contacts CRUD + blocklist still missing |
| Presence | 90% | Full Redis-backed system with worker; not scoped to contacts only |
| Realtime (Socket.IO) | 80% | No rate limiting on WebSocket connections |
| Push Notifications | 90% | FCM + APNs + VoIP; fire-and-forget delivery confirmed |
| Health / Admin | 70% | Metrics endpoint done; /live /ready path mismatch remains |
| Security Infrastructure | 85% | All major items done; audit logging missing |
| Observability | 60% | Custom logger + metrics done; not Pino/prom-client; no OpenTelemetry |
| Reliability Utilities | 65% | Circuit breaker, retry, idempotency built but not wired |
| Testing | 15% | Auth + CORS tests only |
| Infrastructure | 70% | docker-compose.yml present; Dockerfile SSH artifact remains |

---

## What Is Working Today

The following can be tested end-to-end via Postman or `GET /calls/test`:

- User registration with **argon2id** hashing; bcrypt → argon2id migration on next login
- Login / logout with 15-minute httpOnly cookie
- Password forgot / reset flow
- `GET /auth/me` — current user profile
- Initiate a 1:1 or conference call → LiveKit room, token, and **public WebSocket URL** returned
- Real-time `call:incoming` via Socket.IO **and** fire-and-forget push notification (FCM Android / APNs iOS / VoIP PushKit)
- Accept, reject, end a call with proper Socket.IO events to all participants
- Re-invite a missed or rejected participant to an ongoing conference
- Start / stop call recording (LiveKit Egress)
- `GET /calls/history` with pagination
- `GET /calls/:id` — single call detail
- Register and unregister device push tokens (`POST /devices/register`, `DELETE /devices/:token`)
- User list with search, pagination, and **live Redis presence** (`GET /users`)
- `GET /users/:id` — single user profile with live presence
- `GET /users/:id/presence` — real-time Redis-backed per-user presence
- `GET /users/presence` — bulk presence for all users
- `PUT /users/me` — update own display name / avatar
- LiveKit webhooks verified with HMAC: `room_finished`, `participant_joined`, `participant_left`, `egress_ended`
- Health dashboard at `GET /`; liveness `GET /live`; readiness `GET /ready`
- Prometheus-format metrics at `GET /metrics`
- Rate limiting: 200 req/min global, 10 req/15 min on auth endpoints
- `@fastify/helmet` security headers (CSP + HSTS in production)
- MongoDB indexes auto-created on startup (users, calls, devices)
- Global request ID propagation (`X-Request-ID`)

---

## Module Detail

### Auth — 88%

| Feature | Status | Notes |
|---|---|---|
| `POST /auth/signup` | ✅ | argon2id hashing |
| `POST /auth/signin` | ✅ | 15-min cookie; opportunistic bcrypt→argon2id migration |
| `POST /auth/signout` | ✅ | |
| `GET /auth/me` | ✅ | |
| `POST /auth/forgot-password` | ✅ | Reset token SHA-256 hashed in DB |
| `POST /auth/reset-password` | ✅ | Expiry validated |
| Rate limiting on auth endpoints | ✅ | 10 req / 15 min per IP |
| argon2id hashing | ✅ | With bcrypt migration fallback |
| 15-min access token | ✅ | Cookie `maxAge` = 900 s, `expiresIn` = 15m |
| `POST /auth/refresh` | ⚠️ Partial | Accepts expired access token with `ignoreExpiration: true` and re-signs. `jwt.ts` has `signRefreshToken` / `verifyRefreshToken` with a separate `jwtRefreshSecret`, but `auth.routes.ts` defines its own `signToken` and never calls either function — **two parallel implementations, neither complete** |
| Refresh token rotation | ❌ | No opaque refresh token; no revocation |
| Redis session blacklist | ❌ | Stolen cookie valid until 15-min expiry |
| Audit logging | ❌ | No writes to `audit_logs` collection |

---

### Call Lifecycle — 80%

| Feature | Status | Notes |
|---|---|---|
| `POST /calls/initiate` | ✅ | Socket.IO + fire-and-forget push to all receivers |
| `POST /calls/:id/accept` | ✅ | |
| `POST /calls/:id/reject` | ✅ | Per-participant for conference; full for 1:1 |
| `POST /calls/:id/end` | ✅ | Marks pending invites as `missed`; deletes LiveKit room |
| `GET /calls/:id` | ✅ | Authorization checked |
| `GET /calls/history` | ✅ | Paginated, desc by `createdAt` |
| `POST /calls/:id/add-participant` | ✅ | Conference re-invite supported |
| `POST /calls/:id/record/start` | ✅ | LiveKit Egress |
| `POST /calls/:id/record/stop` | ✅ | |
| `missed` participant status on end | ✅ | `markPendingParticipantsAsMissed` called on hang-up |
| `POST /calls/:id/cancel` | ❌ | Caller-side cancel before pickup — not implemented |
| 60-second auto-timeout → missed | ❌ | No BullMQ delayed job or Redis TTL; call stays `initiated` until caller hangs up |
| Callee busy detection | ❌ | `POST /calls/initiate` checks only the **caller's** active call. A callee already in a call still receives the incoming ring |
| Idempotency on `POST /calls/initiate` | ❌ | `idempotency.ts` utility exists but is not wired here |

---

### LiveKit Integration — 90%

| Feature | Status | Notes |
|---|---|---|
| Token generation (SDK v2) | ✅ | |
| Room delete on call end | ✅ | Graceful 404 handling |
| Egress start / stop | ✅ | |
| LiveKit health check | ✅ | |
| Webhook HMAC verification | ✅ | `fastify-raw-body` registered; raw string passed to `receiver.receive()` |
| Public URL returned to clients | ✅ | `getLiveKitPublicUrl()` returns `LIVEKIT_PUBLIC_URL` env var |
| `room_finished` handler | ✅ | Auto-ends call; emits `call:ended` to all |
| `participant_joined` handler | ✅ | Transitions `initiated` → `active` |
| `participant_left` handler | ✅ | Ends 1:1 call on departure |
| `egress_ended` handler | ✅ | Saves `recordingUrl` to call document |
| No-auth dev bypass | ⚠️ Acceptable | Allowed only in non-production |

---

### Presence — 90%

| Feature | Status | Notes |
|---|---|---|
| Redis-backed status (ONLINE / AWAY / OFFLINE) | ✅ | |
| Per-user socket set for multi-device | ✅ | |
| 30-second grace period on disconnect | ✅ | Prevents flicker on mobile backgrounding |
| Startup socket cleanup | ✅ | Clears stale socket sets from previous process |
| Background evaluation worker (60s) | ✅ | ONLINE→AWAY→OFFLINE transitions |
| DB sync worker (5 min) | ✅ | Persists Redis status to `users.presenceStatus` |
| Cross-instance Redis pub/sub | ✅ | `presence:broadcast` channel; subscriber emits to Socket.IO |
| Activity middleware (global HTTP hook) | ✅ | Throttled 30 s; updates `lastActivity` after auth'd requests |
| Presence scoped to contacts | ❌ | `io.emit(event, payload)` in `presence.service.ts:64` broadcasts to **all** connected sockets |
| WS rate limiting | ❌ | |

---

### User Module — 80%

| Endpoint | Status | Notes |
|---|---|---|
| `GET /users` (list, search, pagination) | ✅ | Redis presence enriched via batch pipeline |
| `GET /users/presence` (bulk) | ✅ | Redis source of truth |
| `GET /users/:id` | ✅ | |
| `GET /users/:id/presence` | ✅ | Redis with MongoDB `lastSeen` fallback |
| `GET /auth/me` | ✅ | Current user profile |
| `PUT /users/me` | ✅ | `displayName` and `avatarUrl` |
| `GET /users/me/contacts` | ❌ | |
| `POST /DELETE /users/me/contacts/:id` | ❌ | |
| `POST /users/me/block/:id` | ❌ | `isBlocked` field in schema; nothing sets it |

---

### Notification Module — 90%

| Feature | Status | Notes |
|---|---|---|
| FCM v1 (Android / Web) | ✅ | OAuth2 service-account JWT; auto-refreshed |
| APNs alert push (iOS) | ✅ | JWT auth; sandbox / production toggle |
| VoIP PushKit push (iOS) | ✅ | `pushType: "voip"`, zero expiration |
| `POST /devices/register` | ✅ | Upserts by `(userId, platform, token)` |
| `DELETE /devices/:token` | ✅ | |
| `notifyIncomingCall` wired to `/calls/initiate` | ✅ | Fire-and-forget; failure logged, not fatal |
| `notifyMissedCall` | ✅ Defined | Not yet triggered (needs 60s timeout) |
| Metrics (`push_notifications_sent/failed`) | ✅ | Labelled by platform |
| Async delivery via BullMQ | ❌ | Calls are direct HTTP to FCM/APNs within the request; no job queue |

---

### Realtime (Socket.IO) — 80%

| Feature | Status | Notes |
|---|---|---|
| JWT auth on connection | ✅ | |
| `emitToUser(userId, event, payload)` | ✅ | Routes to all active sockets for a user |
| Multi-device support | ✅ | |
| Re-notify pending calls on reconnect | ✅ | |
| Presence events via Redis pub/sub | ✅ | No longer uses raw `io.emit` for call events |
| Presence scoped to contacts | ❌ | Presence broadcasts still hit all sockets (`io.emit` in presence subscriber) |
| WS connection rate limiting | ❌ | |

---

### Health / Admin — 70%

| Feature | Status | Notes |
|---|---|---|
| HTML health dashboard at `GET /` | ✅ | Mongo / Redis / LiveKit status |
| `GET /live` (liveness) | ✅ | |
| `GET /ready` (readiness) | ✅ | Checks all three dependencies |
| `GET /metrics` (Prometheus format) | ✅ | Custom in-memory counters/histograms |
| `/health/live` and `/health/ready` paths | ❌ Path mismatch | `healthRoutes` registered without prefix in `app.ts` — still at `/live` `/ready`. One-line fix. |
| `GET /admin/calls/active` | ❌ | |

---

### Security Infrastructure — 85%

| Feature | Status | Notes |
|---|---|---|
| JWT auth middleware | ✅ | Bearer header or cookie |
| `@fastify/cors` | ✅ | `cors.ts` allows `FRONTEND_URL` + `localhost` + `*.devtunnels.ms` in dev |
| `@fastify/helmet` | ✅ | CSP + HSTS in production |
| argon2id + bcrypt migration | ✅ | |
| Global rate limiting | ✅ | 200 req/min; 10/15 min on auth |
| Error handler | ✅ | Zod formatting; stack omitted in production |
| MongoDB indexes | ✅ | `ensureIndexes()` on startup |
| `crypto.ts` (token gen, hash, safe compare) | ✅ | |
| `jwt.ts` (access + refresh token signing) | ✅ Implemented | Not wired into `auth.routes.ts` |
| Redis session blacklist | ❌ | |
| Audit logging | ❌ | |

---

### Observability — 60%

| Feature | Status | Notes |
|---|---|---|
| Structured JSON logger | ✅ | Custom — writes JSON to stdout/stderr; respects `LOG_LEVEL` |
| Pino | ⚠️ Partial | Listed in `package.json`; Fastify's built-in pino is configured at bootstrap, but the custom logger is used everywhere else. Two logging paths exist. |
| `/metrics` Prometheus-format | ✅ | Custom in-memory counters/histograms — not `prom-client`; no native Grafana scrape compatibility |
| Request ID propagation | ✅ | `X-Request-ID` honoured and echoed |
| OpenTelemetry tracing | ❌ | `tracing.ts` is only request ID attachment — no spans, no propagation |
| PII in logs | ✅ | Password hash debug log removed; no sensitive fields logged |

---

### Reliability Utilities — 65%

| Feature | Status | Notes |
|---|---|---|
| Graceful shutdown | ✅ | Stops presence worker, closes Redis + Fastify |
| `circuit-breaker.ts` | ✅ Implemented | Not applied to any LiveKit, FCM, or APNs calls |
| `retry.ts` | ✅ Implemented | Not called anywhere |
| `idempotency.ts` | ✅ Implemented | Not wired to any route |
| BullMQ async job queue | ❌ | |

---

### Testing — 15%

| Area | Status |
|---|---|
| `test/auth.routes.test.ts` | ✅ |
| `test/cors.test.ts` | ✅ |
| Call module | ❌ |
| Presence module | ❌ |
| User module | ❌ |
| Notification module | ❌ |
| LiveKit module | ❌ |
| Integration tests (real Mongo + Redis) | ❌ |

---

### Infrastructure — 70%

| Item | Status | Notes |
|---|---|---|
| `docker-compose.yml` | ✅ | Present; includes Mongo, Redis, LiveKit |
| MongoDB indexes on startup | ✅ | |
| `.env.example` | ✅ | FCM, APNs, `LIVEKIT_PUBLIC_URL` all documented |
| `Dockerfile` | ⚠️ Bug | Lines 17–18 still contain developer SSH key paths (`/c/Users/venkat/.ssh/id_ed25519`). These are inert at runtime but must be removed before pushing to any image registry. |
| Helm chart templates | ❌ | Files exist; all content empty |

---

## Open Bugs

### Bug 1 — Dockerfile SSH Key Artifact *(unchanged)*
Lines 17–18 of `Dockerfile` contain developer SSH paths left from a previous edit. Remove before any CI pipeline or image push.

### Bug 2 — Health Route Path Mismatch *(unchanged)*
`GET /live` and `GET /ready` are at the server root. K8s probes and the spec expect `/health/live` and `/health/ready`.

**One-line fix in `app.ts`:** `app.register(healthRoutes)` → `app.register(healthRoutes, { prefix: "/health" })`.

### Bug 3 — Callee Busy Detection Missing *(unchanged)*
`POST /calls/initiate` checks only whether the **caller** is already in an active call. If a callee is in an active call they still receive the `call:incoming` event.

**Fix:** After the caller-busy check, loop over `receiverIds` and call `callRepo.getActiveCallForUser(receiverId)`. Return 409 if any callee is busy.

### Bug 4 — Dual Token-Signing Implementation *(unchanged)*
`auth.routes.ts` has its own `signToken` function that ignores `jwt.ts`. The `POST /auth/refresh` endpoint re-signs an expired **access** token with `ignoreExpiration: true` — there is no real refresh token, no rotation, and no revocation.

**Fix:** Replace `signToken` in `auth.routes.ts` with `signAccessToken` from `jwt.ts`. Implement a proper refresh token flow using `signRefreshToken` / `verifyRefreshToken`, storing the token hash in MongoDB and clearing it on sign-out.

### Bug 5 — Presence Broadcast to All Sockets *(unchanged)*
`presence.service.ts:64` — the Redis pub/sub subscriber calls `io.emit(event.event, event)`, sending every user's presence change to every connected socket regardless of contact relationship.

**Fix:** Scope broadcasts to contact-pair Socket.IO rooms, or maintain a per-user subscriber list and emit only to the relevant sockets.

---

## Priority Action List

Work that is blocking or would meaningfully advance the product:

| Priority | Task | Effort |
|---|---|---|
| 🔴 High | Fix health route prefix (Bug 2) — one-line change | Minutes |
| 🔴 High | Fix callee busy detection (Bug 3) | < 1 hour |
| 🔴 High | Wire `jwt.ts` refresh token into `auth.routes.ts` (Bug 4) | 1–2 hours |
| 🔴 High | `POST /calls/:id/cancel` endpoint | 1–2 hours |
| 🟡 Medium | 60-second auto-missed timeout (BullMQ delayed job or Redis TTL + worker sweep) | Half day |
| 🟡 Medium | Contacts CRUD (`GET/POST/DELETE /users/me/contacts`) | Half day |
| 🟡 Medium | Scope presence broadcasts to contacts (Bug 5) | 1–2 hours |
| 🟡 Medium | Wire `CircuitBreaker` to LiveKit, FCM, APNs calls | 1–2 hours |
| 🟡 Medium | Wire `withIdempotency` to `POST /calls/initiate` | 1 hour |
| 🟢 Low | Blocklist (`POST /users/me/block/:id` + call guard) | Half day |
| 🟢 Low | Remove Dockerfile SSH artifact (Bug 1) | Minutes |
| 🟢 Low | Migrate logger to native Pino; replace custom logger | 1–2 hours |
| 🟢 Low | Replace custom metrics with `prom-client` | 1–2 hours |
| 🟢 Low | Add OpenTelemetry SDK | Half day |
| 🟢 Low | Expand test coverage (call, presence, user modules) | 1–2 days |

---

## Open Questions for the Team

1. **Vipin:** No code was merged to `dev` this week. Is the team on a planned break, or is there active work on a feature branch that hasn't landed yet?

2. **Vipin:** The refresh token infra in `jwt.ts` (`signRefreshToken` / `verifyRefreshToken`) is complete but `auth.routes.ts` doesn't call it. Is this intentional — keeping a single access token — or planned for a future sprint?

3. **Vipin:** The 60-second missed-call timeout is the only remaining Sprint 1 item. Does the team want to use a BullMQ delayed job or a lighter approach (Redis TTL key + worker sweep that already exists in `presence.worker.ts`)?

4. **Nishant:** Calls return `url: getLiveKitPublicUrl()` which is now the correct public URL. Please confirm the frontend is consuming this field from the API response and not hardcoding a WebSocket address.

5. **All:** Health probes are still at `/live` and `/ready`. If any K8s or Docker health check config was set up against these paths, the one-line fix in `app.ts` will break those probes. Coordinate before patching.
