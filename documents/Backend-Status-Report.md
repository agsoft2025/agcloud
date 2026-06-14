# agcloud Backend — Development Status Report

**Date:** June 13, 2026
**Branch reviewed:** `dev` (commit `69adcff`)
**Reference spec:** `documents/Backend-Specification.md`
**Prepared by:** Venkat

---

## Overall Progress at a Glance

| Module | Progress | Status |
|---|---|---|
| Auth | 70% | Functional but incomplete — missing refresh tokens |
| Call Lifecycle | 60% | Core flow works, push & missing states block real usage |
| LiveKit Integration | 50% | Token/room working, webhook signature broken |
| User / Contacts | 10% | Schema only — all routes and logic are empty |
| Push Notifications | 0% | Entire module is empty files |
| Health / Admin | 40% | HTML dashboard only, no Kubernetes-compatible endpoints |
| Security Infrastructure | 15% | Auth middleware done, rate limit / helmet / argon2 missing |
| Observability | 0% | Logger, metrics, tracing all empty |
| Testing | 10% | Auth tests only — no coverage for call or user modules |

---

## What Is Working Today

The following can be tested end-to-end right now via Postman or the built-in WebRTC tester page (`GET /calls/test`):

- User registration and login (cookie-based JWT)
- Password forgot / reset flow
- Initiate a call → generates a LiveKit room and returns a token
- Accept a call → returns a callee token
- Reject / end a call
- Start and stop call recording (LiveKit Egress)
- Health dashboard at `GET /` showing Mongo / Redis / LiveKit status

---

## Module Detail

### Auth Module — 70%

Auth routes are implemented and working. The main gap is the token security model.

| Endpoint / Feature | Status | Notes |
|---|---|---|
| `POST /auth/signup` | ✅ Done | |
| `POST /auth/signin` | ✅ Done | Sets httpOnly cookie |
| `POST /auth/signout` | ✅ Done | Clears cookie |
| `POST /auth/forgot-password` | ✅ Done | Reset token hashed in DB |
| `POST /auth/reset-password` | ✅ Done | Expiry validated |
| `POST /auth/refresh` | ❌ Missing | No refresh token system |
| Refresh token rotation | ❌ Missing | Spec requires separate refresh tokens in DB |
| Short-lived access tokens (15 min) | ❌ Missing | Currently a 7-day cookie — stolen token valid for 7 days |
| Redis session blacklist | ❌ Missing | Cannot revoke a signed-in session |
| argon2id password hashing | ❌ Missing | Using bcrypt; `argon2.ts` is an empty file |
| Rate limiting on login attempts | ❌ Missing | Brute-force unprotected |
| Audit logging | ❌ Missing | No writes to `audit_logs` collection |

**Key risk:** The 7-day access token with no revocation path means a stolen cookie stays valid for 7 days. This needs the refresh token system before going to production.

---

### Call Module — 60%

Core state transitions work. The flow breaks in real-world scenarios because callee devices are never notified.

| Endpoint / Feature | Status | Notes |
|---|---|---|
| `POST /calls/initiate` | ✅ Done | Creates LiveKit room, returns token |
| `POST /calls/:id/accept` | ✅ Done | Returns callee token |
| `POST /calls/:id/reject` | ✅ Done | |
| `POST /calls/:id/end` | ✅ Done | Deletes LiveKit room |
| `GET /calls/:id` | ✅ Done | Authorization checked |
| `POST /calls/:id/record/start` | ✅ Done | LiveKit Egress |
| `POST /calls/:id/record/stop` | ✅ Done | |
| `POST /calls/:id/cancel` | ❌ Missing | Caller cancels before pickup |
| `GET /calls/history` | ❌ Missing | No call history endpoint |
| Push notification to callee | ❌ Missing | Callee is never woken up — call just sits in "initiated" |
| `missed` / `cancelled` / `busy` call states | ❌ Missing | State machine only knows initiated → active → ended/rejected |
| Call timeout (unanswered → missed) | ❌ Missing | No timer or scheduled job |
| Callee busy detection | ⚠️ Partial | Checks caller's active calls but not callee's |
| Idempotency key | ❌ Missing | `idempotency.ts` is an empty file |

**Key risk:** Without push notifications, a real device will never receive the incoming call. The call module cannot be user-tested on physical devices until the notification module is built.

---

### LiveKit Module — 50%

Token generation and room management are solid. The webhook receiver has a critical bug that prevents it from working correctly.

| Feature | Status | Notes |
|---|---|---|
| Token generation (`toJwt()` awaited) | ✅ Done | SDK v2 compatible |
| Room delete on call end | ✅ Done | Graceful 404 handling |
| Egress (recording) start / stop | ✅ Done | |
| LiveKit health check | ✅ Done | |
| `POST /livekit/webhook` | ⚠️ Broken | Fastify parses the body as JSON before HMAC verification — signature always fails |
| Webhook no-auth-header bypass | ❌ Security gap | Falls back to unverified body if Authorization header is absent — works in all environments |
| `room_started` event handler | ❌ Missing | |
| `participant_joined` → state to active | ❌ Missing | Spec requires this to drive call state |
| `egress_ended` → save recording URL | ❌ Missing | |
| Public LiveKit URL for clients | ❌ Wrong | Returns Docker-internal `http://livekit:7880`; browsers cannot connect to this |

**Fix needed:** Add `@fastify/rawbody` plugin and use the raw body string for HMAC verification. Also add a separate `LIVEKIT_PUBLIC_URL` environment variable that is the WebSocket URL the frontend actually connects to.

---

### User Module — 10%

The data schema is well-designed. All routes, service, and repository files are empty.

| Feature | Status |
|---|---|
| `user.schemas.ts` (data model) | ✅ Done |
| `GET /users/me` | ❌ Missing |
| `PATCH /users/me` | ❌ Missing |
| `GET /users/:id` | ❌ Missing |
| `GET /users/me/contacts` | ❌ Missing |
| `POST /users/me/contacts` | ❌ Missing |
| `DELETE /users/me/contacts/:id` | ❌ Missing |
| `POST /users/me/block/:id` | ❌ Missing |
| `GET /users/:id/presence` (Redis) | ❌ Missing |
| `user.routes.ts` / `user.service.ts` / `user.repository.ts` | ❌ All empty files |

---

### Notification Module — 0%

All three files (`fcm.client.ts`, `apns.client.ts`, `notification.service.ts`) exist but are empty. No device registration endpoint has been defined.

| Feature | Status |
|---|---|
| FCM push (Android / Web) | ❌ Not started |
| APNs push (iOS) | ❌ Not started |
| VoIP push / PushKit (iOS call ringing) | ❌ Not started |
| `POST /devices/register` | ❌ Not started |
| `DELETE /devices/:tokenId` | ❌ Not started |
| `devices` MongoDB collection schema | ❌ Not started |

**This is the highest-priority missing feature.** Until push is working, the app cannot ring incoming calls on real devices.

---

### Health Module — 40%

A rich HTML dashboard exists at `GET /`. The lightweight machine-readable endpoints required by Kubernetes are not implemented.

| Feature | Status | Notes |
|---|---|---|
| HTML health dashboard at `GET /` | ✅ Done | Shows live status of Mongo / Redis / LiveKit |
| `GET /health/live` (JSON) | ❌ Missing | Kubernetes liveness probe expects this path |
| `GET /health/ready` (JSON) | ❌ Missing | Kubernetes readiness probe expects this path |
| `GET /metrics` (Prometheus) | ❌ Missing | `metrics.ts` is empty |
| `GET /admin/calls/active` | ❌ Missing | |

---

### Security Infrastructure — 15%

The auth cookie middleware is done and used on all protected routes. Everything else in the security layer is an empty stub.

| Feature | Status | Notes |
|---|---|---|
| `auth.middleware.ts` (JWT cookie) | ✅ Done | Applied to all protected routes |
| `@fastify/cors` | ✅ Done | Origin allowlist in production |
| `@fastify/cookie` | ✅ Done | |
| `argon2.ts` | ❌ Empty | Spec requires argon2id |
| `jwt.ts` / `crypto.ts` | ❌ Empty | |
| `rate-limit.middleware.ts` | ❌ Empty | Login brute-force unprotected |
| `error-handler.ts` | ❌ Empty | Stack traces can leak in unhandled errors |
| `@fastify/helmet` | ❌ Not added | No security headers (CSP, HSTS, X-Frame-Options) |
| MongoDB indexes | ❌ Missing | `users.email`, `calls.status` etc. — all unindexed |
| Debug logs leaking bcrypt hash | ❌ Bug | `console.log("<><>passwordHash", ...)` in signup route |

---

### Observability — 0%

Files exist as placeholders. None are implemented.

| Feature | Status |
|---|---|
| Structured logging / Pino (`logger.ts`) | ❌ Empty |
| Prometheus metrics (`metrics.ts`) | ❌ Empty |
| OpenTelemetry tracing (`tracing.ts`) | ❌ Empty |
| Request ID propagation (`request-id.ts`) | ❌ Empty |
| PII redaction in logs | ❌ Missing |

---

### Reliability Utilities — Partial

Graceful shutdown is done. The resilience utilities are all stubs.

| Feature | Status |
|---|---|
| Graceful shutdown (SIGTERM / SIGINT) | ✅ Done |
| Redis error handling + reconnect | ✅ Done |
| `circuit-breaker.ts` | ❌ Empty |
| `retry.ts` | ❌ Empty |
| `idempotency.ts` | ❌ Empty |
| BullMQ async job queue (push, email) | ❌ Not started |

---

### Testing — 10%

| Area | Status |
|---|---|
| `vitest.config.ts` | ✅ Done |
| Auth routes test (`test/auth.routes.test.ts`, 164 lines) | ✅ Done |
| Call module tests | ❌ Missing |
| LiveKit module tests | ❌ Missing |
| User module tests | ❌ Missing |
| Integration tests (real Mongo + Redis) | ❌ Missing |

---

### Infrastructure — Partial

| Item | Status | Notes |
|---|---|---|
| `Dockerfile` | ✅ Done | Moved to repo root, uses pnpm |
| `.env.example` | ❌ Missing | Not committed on dev branch |
| `docker-compose.yml` | ❌ Removed | Was on main branch — no local infra stack on dev |
| Helm chart templates | ⚠️ Stubs | Files exist, all content is empty |

---

## Critical Bugs to Fix Before Any Demo

These must be resolved before the team can test the product end-to-end:

1. **Debug logs leaking sensitive data** — `console.log("<><>passwordHash", ...)` in signup. Remove all `<><>` debug logs.
2. **Webhook HMAC always fails** — Add `@fastify/rawbody`, pass raw body string to `receiver.receive()`. Without this, LiveKit events (room finished, participant left) are silently ignored in production.
3. **Wrong LiveKit URL returned to clients** — Add `LIVEKIT_PUBLIC_URL` env var and return that instead of the Docker-internal host. Without this, the browser/app cannot connect to LiveKit.

---

## Recommended Sprint Priorities

### Sprint 1 — Make the call flow work on real devices
1. Fix the 3 critical bugs above
2. Build notification module: FCM (Android/web), APNs VoIP (iOS)
3. `POST /devices/register` + `DELETE /devices/:tokenId`
4. Wire push notification into `POST /calls/initiate`
5. Add `missed` state + 60-second call timeout (Redis TTL or BullMQ delayed job)

### Sprint 2 — Complete the user experience
1. All user module endpoints (`/users/me`, contacts, blocklist, presence)
2. `GET /calls/history` with pagination
3. `POST /calls/:id/cancel`
4. Refresh token system (replaces the 7-day cookie with 15-min access + 7-day refresh)

### Sprint 3 — Harden for production
1. Rate limiting on auth endpoints
2. argon2id (replace bcrypt)
3. `@fastify/helmet`
4. MongoDB indexes
5. `error-handler.ts` with structured error responses
6. `/health/live` and `/health/ready` JSON endpoints
7. Prometheus metrics endpoint

### Sprint 4 — Observability and reliability
1. Pino structured logging with PII redaction
2. OpenTelemetry tracing
3. Circuit breakers on LiveKit, FCM, APNs
4. BullMQ for async push/email jobs
5. Integration test suite (real Mongo + Redis via Docker)

---

## Questions for the Team

1. **Vipin (Backend):** The `auth.service.ts`, `auth.repository.ts`, `user.routes.ts`, `user.service.ts`, `user.repository.ts`, and `call.service.ts` files are all empty. Were these intended to be filled in? The current implementation puts all logic directly in the route files. Should we refactor or continue with that pattern?

2. **Vipin (Backend):** The spec requires argon2id but bcrypt is implemented. Should we switch now (easier before users are in production) or defer?

3. **Nishant (Frontend):** The LiveKit URL returned by `/calls/initiate` and `/calls/:id/accept` is currently the Docker-internal URL `http://livekit:7880`. Until this is fixed with a public URL env var, the frontend WebRTC connection will fail. Is the frontend currently hardcoding the LiveKit URL or consuming it from the API response?

4. **Ajay / Venkat:** Notification module is 0% and is blocking real-device testing. Should this become the top priority for next sprint, or is web browser testing (no push needed) sufficient for the near term?

5. **All:** The `docker-compose.yml` was removed on the dev branch. Developers need a way to run Mongo, Redis, and LiveKit locally. Should we restore it or document an alternative setup?
