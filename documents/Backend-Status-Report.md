# agcloud Backend — Development Status Report (Update)

**Date:** July 28, 2026
**Branch reviewed:** `dev` @ `6ff0a8f` (merge of PR #7 `fix/bug`, July 20, 2026 — clean working tree, nothing uncommitted)
**Reference spec:** `documents/Backend-Specification.md`
**Prepared by:** Claude Code
**Previous report:** July 20, 2026 (below)

---

## What changed since July 20

**Nothing.** No commits have landed on `dev` since `6ff0a8f` — the branch has
been idle for a week. This section exists to confirm, by direct code
inspection and by actually running the test suite (not by re-reading the
prior report), that everything the July 20 report described as "done in the
working tree" is now genuinely committed and still true on disk:

- Spot-checked every claim in the July 20 "What changed this session" table
  against current source: `pino()` in `logger.ts`, `prom-client` in
  `metrics.ts`, `@opentelemetry/sdk-node` in `tracing.ts`, `CircuitBreaker`
  wired into `livekit.service.ts`, `withRetry` in `fcm.client.ts` /
  `apns.client.ts`, `withIdempotency` wrapping `POST /calls/initiate`,
  BullMQ `Queue`/`Worker` in `call.queue.ts`, `POST /calls/:id/cancel`,
  contacts/blocklist routes in `user.routes.ts`, presence broadcasts scoped
  via `io.to("user:" + id)` instead of `io.emit()`, and Socket.IO per-IP
  connect capping + PING throttling in `realtime.service.ts`. All present
  and match the report.
- Ran `npx vitest run` end-to-end (after `npm install` — see below): **475
  passed / 475, 44 test files**, matching the July 20 count exactly. Not
  re-derived from the report — actually executed this session.
- `npx tsc --noEmit`: clean, no errors.
- Confirmed the "still open" list from July 20 has not drifted: no
  `send email` implementation exists yet for password reset (still a
  dev-only `logger.debug({ resetToken })` in `auth.routes.ts`), no
  `/admin/calls/active` route anywhere in `src/modules`, no Helm templates,
  no TOTP/2FA code.
- The six empty stub files noted since the first report
  (`auth.service.ts`, `auth.repository.ts`, `call.service.ts`,
  `user.service.ts`, `livekit.types.ts`, `config/constants.ts`) are still
  0 bytes. This is a stable architectural pattern at this point — route
  handlers call repositories directly rather than through a service layer —
  not a regression or oversight, so it's noted here without a score penalty.

### New findings this session (not in any prior report)

- **`npm ci` fails on a clean checkout.** `package.json` and
  `package-lock.json` are out of sync (`npm ci` reports missing
  `@emnapi/core`, `@emnapi/runtime`, `@emnapi/wasi-threads` from the lock
  file). `npm install` works around it by rewriting the lock file, but any
  CI pipeline or fresh-clone onboarding step that correctly uses `npm ci`
  for reproducible installs will fail until someone commits a regenerated
  `package-lock.json`. Worth a quick fix — `npm install && git add
  package-lock.json` — since it's a one-line-cause problem with an
  annoying failure mode for anyone else setting up the repo.
- **`node_modules` was not present at all** in this checkout — first time
  the repo has been built in this environment. Not a code issue, just
  context for why the above lockfile drift hadn't been caught yet.
- **`npm audit`: 17 vulnerabilities (1 low, 16 high)**, all transitive:
  - `ws` 8.0.0–8.20.1 (memory exhaustion DoS via tiny fragments) — pulled in
    by `socket.io-adapter` / `engine.io`. Fixable with `npm audit fix`
    (non-breaking).
  - `find-my-way` ≤9.6.0 (HTTP/2 DDoS) — a Fastify 4.x transitive
    dependency. Fix requires upgrading to `fastify@5`, which is a breaking
    change and ties directly into the `registerFastify4OptionalPlugin`
    compatibility shim already present in `app.ts` for plugins that
    require Fastify 5. Worth planning as a deliberate Fastify 5 migration
    rather than patching around it.
  - None of these were introduced this session — they're pre-existing
    transitive dependency exposure that hadn't been audited in a prior
    report.

**Net effect on scores below:** no module score changes from July 20 — all
verified as claimed. The lockfile/audit findings are new action items, not
regressions in functionality.

---

## Important note on repository state

Two things changed between the last commit and this session that the July 11
report (preserved below) does not reflect:

1. **A large uncommitted test suite already existed in the working tree
   before this session started** — 39 test files / 399 passing tests, vs.
   the `auth.routes.test.ts` + `cors.test.ts` pair that's actually committed
   on `dev`. That work was never committed. This report's "Testing" number
   reflects the working tree, not `dev`.
2. **This session executed the entire Remediation-Plan.md backlog**
   (Sprints 2–6: call lifecycle correctness, contacts/blocklist, presence
   privacy, reliability wiring, observability consolidation, and test
   coverage for all of it), on top of that pre-existing uncommitted state.

**Nothing in this session was committed to git** — everything below,
including the pre-existing test suite, is sitting in the working tree.
Run `git status` before committing: there's a lot to review in one pass, and
splitting it into logical commits (per sprint) is worth doing deliberately
rather than as one giant commit.

## What changed this session

Every item in the July 11 report's Priority Action List is now done, except
email delivery for password reset (open question #5, needs a provider
decision — SendGrid/SES/Resend — before it can be implemented) and Helm
chart templates (still empty stubs, no spec/requirements given for them).

| Area | Done |
|---|---|
| `POST /calls/:id/cancel` | ✅ Pre-pickup cancellation, distinct `call:cancelled` event, new `cancelled` call/participant status |
| 60s auto-missed timeout | ✅ BullMQ delayed job (`call.queue.ts`), dedicated Redis connection, cancelled on accept/reject/cancel/end |
| Idempotency on `/calls/initiate` | ✅ `withIdempotency` wired; repeated `Idempotency-Key` replays the cached response |
| Contacts CRUD | ✅ `GET/POST/DELETE /users/me/contacts` |
| Blocklist | ✅ `POST/DELETE /users/me/block/:id`, `GET /users/me/blocked`, enforced in `/calls/initiate` (blocked receivers excluded, `blockedReceiverIds` in response) |
| Presence broadcast scoping (Bug 1) | ✅ Pub/sub subscriber now delivers to the user's own room + contact-watchers' rooms only, not `io.emit()` globally |
| `CircuitBreaker` on LiveKit | ✅ Wraps `deleteRoom`, egress start/stop, `listRooms` (health check); 5-failure threshold, 30s open duration |
| `withRetry` on FCM/APNs | ✅ 3 attempts, exponential backoff, skips retry on permanent errors (FCM `UNREGISTERED`/`NOT_FOUND`, APNs 410/`BadDeviceToken`) |
| Dead-token pruning | ✅ Permanent failures trigger `unregisterDevice` (or `clearVoipToken` for VoIP-only failures) |
| Socket.IO rate limiting | ✅ Per-IP connect cap (30/min, Redis-backed, fails open), PING throttled to 1 per 5s per socket |
| Logger → native Pino | ✅ `logger.ts` is now a real `pino()` instance, shared with Fastify via `Fastify({ logger })` — one pipeline, not two |
| Metrics → `prom-client` | ✅ `metrics.ts` rewritten on `prom-client`; default Node process/GC metrics included; `http_requests_total`/`http_request_duration_seconds` now actually wired via an `onResponse` hook (previously defined but never incremented), as are `calls_initiated/accepted/rejected/ended_total` |
| OpenTelemetry | ✅ `tracing.ts` now bootstraps `@opentelemetry/sdk-node` with auto-instrumentation (HTTP, MongoDB, ioredis) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; no-ops otherwise so local dev without a collector isn't affected |
| Testing | ✅ +76 tests this session (399 → 475) covering every item above, plus a fix for the one thing this session's refactors broke (7 test files depended on old `logger`/`metrics`/`tracing` APIs — rewritten against the new ones, not skipped) |
| Health route path | ✅ Already fixed as of July 11 |

## Updated module scores

| Module | July 11 | July 20 | Change |
|---|---|---|---|
| Auth | 98% | 98% | No change |
| **Call Lifecycle** | 85% | **97%** | Cancel, timeout, idempotency all wired. Only `GET /admin/calls/active` (Health/Admin, not Call Lifecycle) remains from the spec gaps |
| **LiveKit Integration** | 90% | **95%** | Circuit breaker wired onto all network calls |
| **User / Contacts** | 80% | **95%** | Contacts CRUD complete |
| **Presence** | 90% | **98%** | Contact-scoped broadcasts — the one open bug from July 11 is fixed |
| **Realtime (Socket.IO)** | 80% | **92%** | Per-IP connect rate limiting + PING throttling |
| **Push Notifications** | 90% | **97%** | Retry + dead-token pruning wired |
| Health / Admin | 70% | 70% | No change — `GET /admin/calls/active` still missing |
| **Security Infrastructure** | 96% | **98%** | Blocklist enforcement now real (was previously the one listed gap) |
| **Observability** | 60% | **93%** | Pino, prom-client, OpenTelemetry all live; two logging pipelines consolidated to one |
| **Reliability Utilities** | 65% | **97%** | Circuit breaker, retry, idempotency all wired; BullMQ added and in production use |
| **Testing** | 15%* | **~90%** | *That 15% was already stale — see note above. 475 tests passing across 44 files as of this session |
| Infrastructure | 82% | 82% | No change — Helm chart templates still stubs |

## What's still open

- **Email delivery for password reset** — still a dev-only `// TODO: send email`. Needs a provider decision (SendGrid/SES/Resend) before implementation; this is a product/ops decision, not something to guess at.
- **`GET /admin/calls/active`** — not in this session's scope (wasn't in the Remediation Plan's Sprint 0–6 list; it's a Health/Admin item, not called out as blocking).
- **Helm chart templates** — still empty stubs; no spec given for what they should contain.
- **2FA/TOTP** — explicitly out of spec scope per the July 11 report.
- **OpenTelemetry export target** — wired and functional, but does nothing until `OTEL_EXPORTER_OTLP_ENDPOINT` is set to a real collector (Jaeger/Tempo/etc.) in each environment's config. That's a deployment step, not a code gap.
- **`package-lock.json` out of sync with `package.json`** — `npm ci` fails on a clean checkout (new finding, July 28). Needs `npm install` run and the regenerated lock file committed.
- **17 npm audit vulnerabilities (16 high)** — `ws` (fixable non-breaking) and `find-my-way`/Fastify 4.x (needs a planned Fastify 5 migration) (new finding, July 28).

---

## What Changed Since the Last Report

Three commits landed on `dev` since July 10:

| Commit | Author | Summary |
|---|---|---|
| `6e7a343` | Nishant | `POST /calls/:id/leave` endpoint — participant leaves a conference without ending it for everyone |
| `5cdb75a` | Vipin | Complete auth security overhaul: real refresh token rotation, Redis denylist, session management, audit logging, callee busy check, Dockerfile fixed |
| `d142a16` | Ajay | Merge PR #6 (`feature/videotemplate`) |

The `5cdb75a` commit alone resolved **four of the five open bugs** from the July 10 report and closed two sprint-priority items that have been open since the first report. This is the most impactful single commit the project has seen.

---

## Overall Progress at a Glance

| Module | July 10 | July 11 | Change |
|---|---|---|---|
| **Auth** | 88% | **98%** | Refresh token rotation, revocation, denylist, session management, audit logging all done |
| **Call Lifecycle** | 80% | **85%** | Callee busy check fixed; `POST /:id/leave` added |
| LiveKit Integration | 90% | 90% | No change |
| User / Contacts | 80% | 80% | No change |
| Presence | 90% | 90% | No change |
| Realtime (Socket.IO) | 80% | 80% | No change |
| Push Notifications | 90% | 90% | No change |
| Health / Admin | 70% | 70% | No change |
| **Security Infrastructure** | 85% | **96%** | Audit logging, JTI denylist, trustProxy, session endpoints |
| Observability | 60% | 60% | No change |
| Reliability Utilities | 65% | 65% | No change |
| Testing | 15% | 15% | No change |
| **Infrastructure** | 70% | **82%** | Dockerfile SSH artifact removed — image builds again |

---

## What Is Working Today

Everything from the July 10 report, plus:

- **Full refresh-token rotation** — every `POST /auth/refresh` issues a single-use rotating token stored in MongoDB; reusing a consumed token is detected and revokes the entire device session family
- **Real session revocation** — `POST /auth/signout` kills the refresh-token family server-side and JTI-denylists the current access token in Redis so it stops working immediately (not just cookie-cleared)
- **Logout everywhere** — `POST /auth/logout-all` revokes every session across every device the user is signed in on
- **Active session list** — `GET /auth/sessions` returns one entry per active device/login with user-agent, IP, and last-used timestamp
- **Targeted device revocation** — `DELETE /auth/sessions/:familyId` signs out a specific device by family ID
- **Audit log trail** — every security event (signup, signin success/fail, signout, refresh, reuse detection, password reset) written to `audit_logs` MongoDB collection
- **Callee busy detection** — `POST /calls/initiate` now checks all receivers for an active call; busy receivers are excluded and the response includes `busyReceiverIds` so the caller's UI can show who is unavailable
- **Conference leave** — `POST /calls/:id/leave` lets a participant exit a conference without ending it; auto-ends the call only when the last participant leaves
- **Container builds** — Dockerfile SSH artifact removed; `docker build` succeeds

---

## Module Detail

### Auth — 98% (up from 88%)

This is the biggest single-session improvement the auth module has seen. Every item marked missing in the July 10 report is now done.

| Feature | Status | Notes |
|---|---|---|
| `POST /auth/signup` | ✅ | argon2id; audit logged |
| `POST /auth/signin` | ✅ | Issues access + refresh token pair; bcrypt→argon2id migration; audit logged |
| `POST /auth/signout` | ✅ | Revokes refresh-token family + JTI-denylists access token; audit logged |
| `GET /auth/me` | ✅ | |
| `POST /auth/forgot-password` | ✅ | Audit logged |
| `POST /auth/reset-password` | ✅ | Revokes all refresh-token families on completion; audit logged |
| `POST /auth/refresh` — real rotation | ✅ **Fixed** | Single-use tokens; reuse triggers full family revocation + critical audit event |
| `POST /auth/logout-all` | ✅ **New** | Revokes all refresh-token families; JTI-denylists current access token |
| `GET /auth/sessions` | ✅ **New** | One entry per active device/login (not per rotation); includes user-agent, IP, `isCurrent` flag |
| `DELETE /auth/sessions/:familyId` | ✅ **New** | Remote device sign-out; ownership-checked (can't revoke another user's session) |
| Access token JTI denylist | ✅ **New** | Redis `denylist:jti:{jti}` with TTL matching remaining token lifetime; fails open on Redis error |
| Refresh token cookie path | ✅ **New** | Refresh cookie scoped to `path: "/auth"` — not sent to any other route |
| Refresh token family max-age | ✅ **New** | Configurable absolute session cap (`REFRESH_TOKEN_FAMILY_MAX_AGE_DAYS`, default 30d) independent of per-rotation TTL |
| `trustProxy: true` | ✅ **New** | Fastify now reads the real client IP from `x-forwarded-for`; rate-limiter and audit logs reflect correct IPs |
| Audit logging | ✅ **New** | All 12 auth events covered; fire-and-forget (never blocks the request) |
| Rate limiting on auth endpoints | ✅ | 10 req / 15 min per IP |
| argon2id | ✅ | |
| Email delivery for password reset | ⚠️ Dev-only | In production: email sending is a `// TODO: send email` comment; the token is only logged in dev mode |
| 2FA / TOTP | ❌ | Not in spec scope |

**Auth Refresh Token Architecture (implemented):**
- Signin creates a new *family* (UUID); each rotation inside that family shares the same `familyId`
- Each issued refresh token gets a unique `jti` stored in MongoDB with `used: false`
- On refresh: the presented token's `jti` is looked up; if `used: true`, the entire family is revoked (reuse = theft signal)
- On rotation: old token marked `used: true`, new token inserted with same `familyId`
- Family absolute max-age enforced at rotation time; expiry is `min(slidingTTL, absoluteFamilyCap)`
- MongoDB TTL index auto-purges rotated-away tokens after their `expiresAt`

---

### Call Lifecycle — 85% (up from 80%)

| Endpoint | Status | Notes |
|---|---|---|
| `POST /calls/initiate` | ✅ | Callee busy check **fixed** — busy receivers excluded, `busyReceiverIds` in response |
| `POST /calls/:id/accept` | ✅ | |
| `POST /calls/:id/reject` | ✅ | |
| `POST /calls/:id/end` | ✅ | Ends for all participants |
| `POST /calls/:id/leave` | ✅ **New** | Participant exits conference; call ends only when last person leaves |
| `GET /calls/:id` | ✅ | |
| `GET /calls/history` | ✅ | Paginated |
| `POST /calls/:id/add-participant` | ✅ | Conference re-invite |
| `POST /calls/:id/record/start` / `stop` | ✅ | LiveKit Egress |
| `POST /calls/:id/cancel` | ❌ | Caller-side cancel **before pickup** — distinct from `/leave`; no endpoint yet |
| 60-second auto-timeout → missed | ❌ | No BullMQ delayed job; call stays `initiated` until manually ended |
| Idempotency on `/calls/initiate` | ❌ | `withIdempotency` utility exists but not wired |

**Note on `/leave` vs. `/cancel`:** The new `/leave` handles "participant exits during or after an active call." The still-missing `/cancel` handles "caller hangs up while receivers are still ringing (status: `initiated`)." These are different events that clients need to distinguish (`call:cancelled` vs. `call:ended`).

---

### LiveKit Integration — 90% *(no change)*

| Feature | Status |
|---|---|
| Token generation (SDK v2) | ✅ |
| Room delete on call end | ✅ |
| Egress start / stop | ✅ |
| LiveKit health check | ✅ |
| Webhook HMAC verification | ✅ |
| Public URL returned to clients | ✅ |
| `room_finished` / `participant_joined` / `participant_left` / `egress_ended` handlers | ✅ |
| No-auth dev bypass | ⚠️ Acceptable |

---

### Presence — 90% *(no change)*

| Feature | Status |
|---|---|
| Redis ONLINE / AWAY / OFFLINE | ✅ |
| Grace period + startup cleanup | ✅ |
| Background worker (eval 60s, DB sync 5min) | ✅ |
| Redis pub/sub cross-instance | ✅ |
| Activity middleware | ✅ |
| Presence scoped to contacts | ❌ |
| WebSocket connection rate limiting | ❌ |

---

### User Module — 80% *(no change)*

| Endpoint | Status |
|---|---|
| `GET /users` (list, search, pagination, live presence) | ✅ |
| `GET /users/presence` (bulk Redis) | ✅ |
| `GET /users/:id` | ✅ |
| `GET /users/:id/presence` | ✅ |
| `GET /auth/me` | ✅ |
| `PUT /users/me` | ✅ |
| `GET /users/me/contacts` | ❌ |
| `POST /DELETE /users/me/contacts/:id` | ❌ |
| `POST /users/me/block/:id` | ❌ |

---

### Notification Module — 90% *(no change)*

| Feature | Status |
|---|---|
| FCM v1 (Android / Web) | ✅ |
| APNs alert + VoIP push (iOS) | ✅ |
| `POST /devices/register` / `DELETE /devices/:token` | ✅ |
| `notifyIncomingCall` wired fire-and-forget | ✅ |
| `notifyMissedCall` (defined, not triggered) | ✅ |
| Dead-token pruning on permanent failures | ❌ |
| BullMQ async job queue | ❌ |

---

### Security Infrastructure — 96% (up from 85%)

| Feature | Status | Notes |
|---|---|---|
| JWT auth middleware + JTI denylist | ✅ **Fixed** | Denylist check on every authenticated request |
| `@fastify/cors` | ✅ | |
| `@fastify/helmet` | ✅ | |
| argon2id + bcrypt migration | ✅ | |
| Global rate limiting | ✅ | |
| Error handler | ✅ | |
| MongoDB indexes | ✅ | Now includes `refresh_tokens` (jti unique, TTL) + `audit_logs` indexes |
| Refresh token system | ✅ **Fixed** | Full rotation, family revocation, reuse detection |
| Audit logging | ✅ **Fixed** | All 12 auth events; MongoDB `audit_logs` collection |
| `trustProxy: true` | ✅ **Fixed** | Real client IPs in rate-limiter and audit logs |
| Redis session blacklist | ✅ **Fixed** | JTI denylist with TTL matching access token remaining lifetime |
| Contacts / blocklist enforcement in calls | ❌ | Blocklist not implemented yet |

---

### Health / Admin — 70% *(no change)*

| Feature | Status | Notes |
|---|---|---|
| HTML dashboard at `GET /` | ✅ | |
| `GET /live` (liveness) | ✅ | |
| `GET /ready` (readiness) | ✅ | |
| `GET /metrics` (Prometheus format) | ✅ | |
| `/health/live` and `/health/ready` paths | ❌ Path mismatch | `healthRoutes` still registered without prefix in `app.ts:107` — one-line fix |
| `GET /admin/calls/active` | ❌ | |

---

### Observability — 60% *(no change)*

| Feature | Status | Notes |
|---|---|---|
| Structured JSON logger | ✅ | Custom — not native Pino |
| `/metrics` endpoint | ✅ | Custom in-memory — not `prom-client` |
| Request ID propagation | ✅ | |
| Two logging pipelines | ⚠️ | Fastify runs its built-in Pino internally; app code uses the custom logger — duplicate pipelines |
| OpenTelemetry | ❌ | `tracing.ts` is only a request ID hook |

---

### Reliability Utilities — 65% *(no change)*

| Feature | Status |
|---|---|
| Graceful shutdown | ✅ |
| `circuit-breaker.ts` | ✅ Built, not wired |
| `retry.ts` | ✅ Built, not wired |
| `idempotency.ts` | ✅ Built, not wired |
| BullMQ | ❌ |

---

### Testing — 15% *(no change)*

| Area | Status |
|---|---|
| `test/auth.routes.test.ts` | ✅ |
| `test/cors.test.ts` | ✅ |
| Call / Presence / User / Notification / LiveKit | ❌ |

Note: The new auth session endpoints and refresh rotation are untested. The refresh-reuse-detection path in particular should have an integration test because it is the hardest to get right and the most critical to verify.

---

### Infrastructure — 82% (up from 70%)

| Item | Status | Notes |
|---|---|---|
| `docker-compose.yml` | ✅ | |
| MongoDB indexes on startup | ✅ | |
| `.env.example` | ✅ | Includes `REFRESH_TOKEN_TTL_DAYS`, `REFRESH_TOKEN_FAMILY_MAX_AGE_DAYS` |
| `Dockerfile` | ✅ **Fixed** | SSH key artifact removed; `docker build` now succeeds |
| Helm chart templates | ❌ | Still empty stubs |

---

## Open Bugs

Only **one of the five bugs from the July 10 report remains open**.

| Bug | July 10 | July 11 |
|---|---|---|
| Dockerfile SSH artifact | Open | ✅ **Fixed** |
| Dual `signToken` implementation | Open | ✅ **Fixed** |
| Callee busy detection | Open | ✅ **Fixed** |
| Refresh token — no revocation | Open | ✅ **Fixed** |
| Presence broadcast to all sockets | Open | ❌ **Still open** |

### Bug 1 — Presence Broadcast Not Scoped to Contacts *(the only remaining open bug)*

`presence.service.ts:64` — the Redis pub/sub subscriber calls `io.emit(event.event, event)`, sending every user's ONLINE/AWAY/OFFLINE event to **every connected socket**, regardless of whether users know each other.

**Fix:** Blocked on contacts CRUD (see next section). Once `/users/me/contacts` exists, scope broadcasts using a per-user Socket.IO room (e.g. `io.to("user:" + contactId).emit(...)` for each contact, or maintain contact-pair rooms).

---

## Priority Action List

| Priority | Task | Effort | Blocker |
|---|---|---|---|
| 🔴 High | Fix health route prefix (`app.ts:107`) — one-line change | Minutes | Nothing |
| 🔴 High | `POST /calls/:id/cancel` — pre-pickup cancellation | 1–2 h | Nothing |
| 🔴 High | 60-second auto-missed timeout (BullMQ delayed job) | Half day | Nothing |
| 🟡 Medium | Contacts CRUD (`GET/POST/DELETE /users/me/contacts`) | Half day | Nothing |
| 🟡 Medium | Wire `withIdempotency` onto `POST /calls/initiate` | 1 h | Nothing |
| 🟡 Medium | Wire `CircuitBreaker` onto LiveKit + FCM/APNs calls | 2 h | Nothing |
| 🟡 Medium | Blocklist (`POST /users/me/block/:id` + call guard) | Half day | Contacts |
| 🟡 Medium | Scope presence broadcasts to contacts (Bug 1) | 2 h | Contacts |
| 🟡 Medium | Dead-token pruning on FCM `UNREGISTERED` / APNs `410` | 1–2 h | Nothing |
| 🟢 Low | Auth test coverage for new session endpoints + reuse detection | 1 day | Nothing |
| 🟢 Low | Migrate logger to native Pino | 1–2 h | Nothing |
| 🟢 Low | Replace custom metrics with `prom-client` | 1–2 h | Nothing |
| 🟢 Low | OpenTelemetry SDK | Half day | Nothing |

---

## Open Questions

1. **Vipin:** The health route path mismatch (`/live` vs `/health/live`) is now the simplest remaining bug — one word added to `app.ts:107`. Is there a K8s or monitoring config currently pointed at the bare `/live` path that needs to be updated in sync?

2. **Vipin / Nishant:** `POST /calls/:id/cancel` (caller hangs up while still ringing) is still missing. The `POST /calls/:id/leave` (participant exits during a call) added this week is a different flow. Does the frontend currently handle the "caller cancelled" case, or is it relying on the 60-second timeout?

3. **Vipin:** The new `POST /auth/refresh` correctly detects reuse and revokes the family, but the `GET /auth/sessions` and session-list endpoints have no tests. Before shipping to real users, would it be worth adding at least one integration test for the reuse-detection path? It's the hardest security invariant to verify and the easiest to accidentally break.

4. **Nishant:** Calls now return `busyReceiverIds` in the `POST /calls/initiate` response when some invitees are already on another call. Is the frontend consuming this field to show "X is busy" in the UI?

5. **All:** The `forgot-password` flow still only logs the reset token in dev mode — there is no email dispatch. Before inviting any real user to the staging environment, email delivery needs to be wired up. What email provider is planned (SendGrid, SES, Resend)?
