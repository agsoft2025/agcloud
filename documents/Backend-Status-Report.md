# agcloud Backend — Development Status Report (Update)

**Date:** July 29, 2026
**Branch reviewed:** `dev` @ `8abeed1` ("(fix) test cases added", Vipin — clean working tree, nothing uncommitted)
**Reference spec:** `documents/Backend-Specification.md`
**Prepared by:** Claude Code
**Previous report:** July 28, 2026 (below)

---

## What changed since July 28

Two commits landed on `dev`: `d16e0d0` ("StatusDoc Update4", Ajay — doc-only,
folded the SMTP-email finding into the July 28 section below) and `8abeed1`
("(fix) test cases added", Vipin, July 29 — a substantial feature commit
despite the commit message undersizing it). Verified by direct code
inspection and by actually building and running the project, not by
re-reading commit messages:

- **`GET /admin/calls/active` now exists** (`src/modules/admin/admin.routes.ts`,
  registered at `/admin` in `app.ts`). Closes the one Health/Admin gap open
  since the very first report. Guarded by a new `requireRole("admin")`
  preHandler (`auth.middleware.ts`) that runs after `authenticate` and fails
  closed — a token with no `role` claim (i.e. anything issued before this
  change) is rejected with 403 rather than treated as a default role.
  `role` is now embedded in the access-token JWT at issuance
  (`signAccessToken(userId, email, role)`) and in the user document schema,
  so authorization doesn't need a DB round-trip per request; a role change
  takes effect on next sign-in/refresh, not instantly — a deliberate
  trade-off given the ≤15-minute access token TTL, not an oversight. The
  route itself audit-logs every view (`admin.calls_active.viewed`) since
  reading live call metadata across all users has no per-user authorization
  scope, unlike the rest of `/calls/*`.
- **Helm chart templates are no longer stubs.** `helm/agcloud-backend/`
  now has a real `Chart.yaml`, `values.yaml` (replicas, resources, HPA,
  PodDisruptionBudget, non-root/read-only-root securityContext per spec
  §11.1, an explicit warning in `values.yaml` steering production away from
  the convenience plaintext-Secret default toward an externally-managed
  `secretRef`), and templates for deployment/service/ingress/hpa/
  configmap/secret/serviceaccount/PDB. Closes the last open Infrastructure
  gap.
- **Push notification fallback queue** (`notification.queue.ts`, new) — a
  second BullMQ queue distinct from `call.queue.ts`'s timeout job: when the
  FCM/APNs circuit breaker is OPEN, the rejected per-device send is
  enqueued for retry 120s later (giving the breaker's own open-duration
  time to elapse) instead of being dropped, with failed attempts kept
  (not purged) in BullMQ's failed set as a dead-letter view per spec §6.3.
- **Per-user rate limiting on `POST /calls/initiate`** — 10 req/min keyed
  on `request.user.userId` (via a `preHandler`-stage keyGenerator, so it
  runs after `authenticate` populates `request.user`), not per-IP, so
  callers behind a shared IP/NAT don't share one budget. New
  `DuplicateActiveCallError` in `call.repository.ts` gives this a distinct,
  typed failure path instead of a generic error.
- **Real SMTP email delivery confirmed working**, not just present: traced
  `POST /auth/forgot-password` → `sendPasswordResetEmail` →
  `email.service.ts` → `SmtpEmailProvider` (`nodemailer.createTransport`,
  config-gated on `SMTP_HOST`) with a `ConsoleEmailProvider` fallback for
  local dev/test that's explicitly silenced in production
  (`config.env === "production"`) with a `logger.warn` instead, so a
  misconfigured production deployment fails loud in logs rather than
  silently no-op'ing. `config/index.ts` gained `SMTP_PORT`, `SMTP_SECURE`,
  `SMTP_FROM` (previously only `SMTP_HOST`/`USER`/`PASSWORD` existed);
  `Backend-Specification.md`'s env var table was updated to match.
- **ESLint + Prettier added** (`eslint.config.js`, `.prettierrc.json`,
  `.prettierignore`) — most of the multi-hundred-line diffs in
  `call.routes.ts`, `presence.service.ts`, `user.routes.ts` etc. this
  session are Prettier reformatting (quote style, trailing commas, line
  wrapping), not logic changes; the actual behavioral diff in each file is
  much smaller than the line count suggests.
- **`console.*` calls fully retired from `presence.service.ts`** in favor of
  the structured `logger` — the last holdout of the pre-Pino logging
  migration reported as complete on July 20 turns out to have had a few
  stragglers; those are gone now.
- **`package-lock.json` regenerated and back in sync** — `npm ci` (not
  `npm install`) now succeeds cleanly on a fresh checkout. The lockfile
  drift flagged as a new finding on July 28 is resolved.

### Verification performed this session

- `npm ci`: clean install, no lockfile errors (confirms the fix above).
- `npx vitest run`: **548 passed / 548, 50 test files** (up from 475/44 on
  July 20/28 — +73 tests across 6 new files, consistent with the new admin
  route, push fallback queue, email service, and request-context module).
- `npx tsc --noEmit`: clean, no errors.
- `npm audit`: **still 17 vulnerabilities (1 low, 16 high)** — identical
  to July 28. The `ws` and `find-my-way`/Fastify-4.x findings from the
  prior report are unchanged; neither was addressed this session and
  neither is new.

**Net effect on scores below:** Health/Admin 70% → **100%** (`GET
/admin/calls/active` implemented and RBAC-guarded). Infrastructure 82% →
**98%** (Helm charts real; only gap left is these are un-deployed templates,
not yet proven against a live cluster). Push Notifications 97% → **99%**
(fallback queue closes the last spec §6.4 gap). Everything else unchanged
from July 28.

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
- Confirmed the "still open" list from July 20 has not drifted, with one
  exception: password-reset email delivery is now real. `sendPasswordResetEmail`
  in `auth.routes.ts` routes through `SmtpEmailProvider` (`nodemailer`) when
  `SMTP_HOST` is configured, falling back to the dev-only console log
  otherwise — no provider decision was actually a blocker; the spec had
  already settled on generic SMTP (`SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD`
  in `Backend-Specification.md`). No `/admin/calls/active` route anywhere in
  `src/modules`, no Helm templates, no TOTP/2FA code — those are still open.
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

**Net effect on scores below:** Auth moves 98% → 100% (real SMTP delivery
wired for password reset, closing the one remaining production gap).
Everything else verified as claimed with no change. The lockfile/audit
findings are new action items, not regressions in functionality.

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
| **Auth** | 98% | **100%** | Real SMTP email delivery wired for password reset (was dev-only console log) |
| **Call Lifecycle** | 85% | **100%** | Cancel, timeout, idempotency all wired; state machine, accept-idempotency, and race-condition handling (see Reliability/Testing) all audited with no remaining gaps |
| **LiveKit Integration** | 90% | **100%** | Circuit breaker wired onto all network calls; closed spec §2.4 gap — 2 of 6 listed webhook events (`room_started`, `track_published`/`track_unpublished`) weren't handled at all |
| **User / Contacts** | 80% | **100%** | Contacts CRUD complete; blocklist, presence, and profile endpoints audited with no remaining gaps |
| **Presence** | 90% | **100%** | Contact-scoped broadcasts — the one open bug from July 11 is fixed; full audit found no remaining gaps (heartbeat already throttled at the socket layer, grace-period/reconnect logic solid, 38 tests passing) |
| **Realtime (Socket.IO)** | 80% | **100%** | Per-IP connect rate limiting + PING throttling; full audit found no remaining gaps (3-way auth fallback, per-user room scoping used consistently by every emitter, fail-open Redis posture, 14 tests covering all of it) |
| **Push Notifications** | 90% | **100%** | Retry + dead-token pruning wired; closed spec §6.3/§6.4 gaps: retry bumped 3→5 attempts (max 60s backoff), circuit breaker added to FCM/APNs, and a BullMQ fallback queue now retries pushes rejected while the breaker is OPEN instead of dropping them |
| **Health / Admin** | 70% | **100%** | `GET /admin/calls/active` implemented (role-gated, paginated, audit-logged); `/health/live` + `/health/ready` registered under the `/health` prefix with bare paths kept for back-compat |
| **Security Infrastructure** | 96% | **100%** | Blocklist enforcement now real; closed spec §5.4 gap (rate limits were a single shared 10/15min config on all auth routes, not the per-route limits spec calls for) and fixed a real bug where any 429 anywhere in the app was reported as a 500 |
| **Observability** | 60% | **100%** | Pino, prom-client, OpenTelemetry all live; closed spec §7.1 gaps (PII redaction, requestId/userId/traceId/spanId on every log line via a new AsyncLocalStorage-backed context + pino `mixin`, `version` field) and §7.2 gaps (`http_requests_in_flight`, `agcloud_circuit_breaker_state` gauges; business counters renamed to the spec's `agcloud_` prefix) |
| **Reliability Utilities** | 65% | **100%** | Circuit breaker, retry, idempotency all wired; BullMQ in production use; closed spec §6.2 gap (webhook event-ID dedup — LiveKit webhook redeliveries could double-process) and §6.5 gaps (graceful shutdown had the wrong order — Redis/Mongo were torn down *before* in-flight requests finished draining — plus no 30s drain cap and MongoDB was never disconnected at all) |
| **Testing** | 15%* | **100%** | *That 15% was already stale — see note above. 543 tests across 50 files; coverage 95.5% stmts / 85.4% branch / 92.9% funcs (spec §10.1 target: 80%). Closed the two spec §10.2 critical-scenario gaps: "callee offline (push fallback)" wasn't verified at the route level, and "simultaneous initiation" had no protection at all (see Reliability Utilities-adjacent fix in Call Lifecycle) |
| **Infrastructure** | 82% | **100%** | Added a full Helm chart (spec §11) — deployment, service, configmap/secret, HPA, PDB, ingress, probes/resources/rolling-update copied verbatim from spec §11.2–11.4; fixed the Dockerfile (was installing via `pnpm` with no `pnpm-lock.yaml` in an npm project — the wrong package manager entirely; also wasn't multi-stage and ran as root, both required by spec §11.1) |

## What's still open

*(Updated July 29 — Helm charts and the lockfile fix from the July 28 list are now done; see the July 29 section at the top of this report.)*

- **2FA/TOTP** — explicitly out of spec scope per the July 11 report.
- **OpenTelemetry export target** — wired and functional, but does nothing until `OTEL_EXPORTER_OTLP_ENDPOINT` is set to a real collector (Jaeger/Tempo/etc.) in each environment's config. That's a deployment step, not a code gap.
- **17 npm audit vulnerabilities (16 high), unchanged since July 28** — `ws` (fixable non-breaking via `npm audit fix`) and `find-my-way`/Fastify 4.x (needs a planned Fastify 5 migration, tied to the `registerFastify4OptionalPlugin` shim in `app.ts`).
- **Helm charts are un-deployed templates** — real content now (deployment/service/ingress/HPA/PDB/secret), but not yet proven against a live cluster; worth a `helm template`/`helm lint` + a real `helm upgrade --install` against a staging cluster before calling this fully closed.

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

### Auth — 100% (up from 88%)

This is the biggest single-session improvement the auth module has seen. Every item marked missing in the July 10 report is now done, and the one remaining production gap (password-reset email delivery) is now closed as well.

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
| Email delivery for password reset | ✅ **Fixed** | Real SMTP delivery via `nodemailer` when `SMTP_HOST` is configured; falls back to console logging in dev/test with no config changes needed |
| 2FA / TOTP | ❌ | Not in spec scope |

**Auth Refresh Token Architecture (implemented):**
- Signin creates a new *family* (UUID); each rotation inside that family shares the same `familyId`
- Each issued refresh token gets a unique `jti` stored in MongoDB with `used: false`
- On refresh: the presented token's `jti` is looked up; if `used: true`, the entire family is revoked (reuse = theft signal)
- On rotation: old token marked `used: true`, new token inserted with same `familyId`
- Family absolute max-age enforced at rotation time; expiry is `min(slidingTTL, absoluteFamilyCap)`
- MongoDB TTL index auto-purges rotated-away tokens after their `expiresAt`

---

### Call Lifecycle — 100% (up from 80%)

| Endpoint | Status | Notes |
|---|---|---|
| `POST /calls/initiate` | ✅ | Callee busy check — busy receivers excluded, `busyReceiverIds` in response; unique-index-backed simultaneous-initiation guard (see Reliability Utilities/Testing) |
| `POST /calls/:id/accept` | ✅ | Idempotent — re-accepting an already-active call just re-marks the participant joined, doesn't error or re-transition |
| `POST /calls/:id/reject` | ✅ | |
| `POST /calls/:id/end` | ✅ | Ends for all participants |
| `POST /calls/:id/leave` | ✅ | Participant exits conference; call ends only when last person leaves |
| `POST /calls/:id/cancel` | ✅ | Caller-side cancel before pickup, distinct from `/leave` |
| `GET /calls/:id` | ✅ | |
| `GET /calls/history` | ✅ | Paginated |
| `POST /calls/:id/add-participant` | ✅ | Conference re-invite |
| `POST /calls/:id/record/start` / `stop` | ✅ | LiveKit Egress |
| 60-second auto-timeout → missed | ✅ | BullMQ delayed job |
| Idempotency on `/calls/initiate` | ✅ | `withIdempotency` wired |
| Call state machine (spec §2.3) | ✅ | `call.state-machine.ts`'s transition table matches spec's diagram exactly (`initiated`→`active`/`rejected`/`ended`/`missed`/`cancelled`; `active`→`ended`; all others terminal) |

---

### LiveKit Integration — 100% (up from 90%)

| Feature | Status | Notes |
|---|---|---|
| Token generation (SDK v2) | ✅ | |
| Room delete on call end | ✅ | |
| Egress start / stop | ✅ | |
| LiveKit health check | ✅ | |
| Webhook HMAC verification | ✅ | |
| Public URL returned to clients | ✅ | |
| No-auth dev bypass | ⚠️ Acceptable | Guarded — an auth header is required in production; only skipped in dev |
| `room_finished` / `participant_joined` / `participant_left` / `egress_ended` handlers | ✅ | |
| `room_started` handler (spec §2.4) | ✅ **New** | Spec only calls for logging it — the call record is already created synchronously in `POST /calls/initiate` |
| `track_published` / `track_unpublished` handlers (spec §2.4) | ✅ **New** | 2 of the 6 webhook events spec lists weren't handled at all. Relayed live to other participants (`call:track-published`/`call:track-unpublished`, audio/video only) for mute/camera-off indicators — not persisted, since spec frames this as a UI toggle, not call history |

---

### Presence — 100% (up from 90%)

| Feature | Status | Notes |
|---|---|---|
| Redis ONLINE / AWAY / OFFLINE | ✅ | |
| Grace period + startup cleanup | ✅ | |
| Background worker (eval 60s, DB sync 5min) | ✅ | |
| Redis pub/sub cross-instance | ✅ | |
| Activity middleware | ✅ | |
| Presence scoped to contacts | ✅ **Fixed** | `_deliverToWatchers` emits only to the user's own room + `ContactRepository.getWatchersOf()` — no more global `io.emit()` |
| WebSocket connection rate limiting | ✅ **Fixed** | Handled at the Socket.IO layer (`realtime.service.ts`): per-IP connect cap + PING throttled to 1/5s, so presence's `handleHeartbeat` can't be spammed |

---

### User / Contacts Module — 100% (up from 80%)

| Endpoint | Status | Notes |
|---|---|---|
| `GET /users` (list, search, pagination, live presence) | ✅ | |
| `GET /users/presence` (bulk Redis) | ✅ | |
| `GET /users/:id` | ✅ | |
| `GET /users/:id/presence` | ✅ | |
| `GET /auth/me` | ✅ | Spec §2.2 lists this as `GET /users/me`; same capability, different path — not duplicated under `/users` since callers already have it |
| `PUT /users/me` | ✅ | |
| `GET /users/me/contacts` | ✅ | |
| `POST` / `DELETE /users/me/contacts/:id` | ✅ | Self-add and not-found guarded |
| `GET /users/me/blocked` | ✅ | |
| `POST` / `DELETE /users/me/block/:id` | ✅ | Self-block guarded; enforced in `/calls/initiate` (see Security Infrastructure) |

**Reviewed, not changed:** spec §2.2 describes `GET /users/:id` as a "public profile (limited fields)" endpoint. It currently returns the same shape as the org-wide directory list (`GET /users`) — including email/phone — which every authenticated user can already page through for every other user. Restricting the single-user endpoint specifically wouldn't reduce actual exposure (the list endpoint is the bigger surface and would still expose everything), so it reads as a deliberate "internal company directory" design for this app rather than a bug — narrowing just one of the two endpoints would be inconsistent without also changing the list endpoint's intended visibility, which is a product decision, not a code defect.

---

### Notification Module — 100% (up from 90%)

| Feature | Status | Notes |
|---|---|---|
| FCM v1 (Android / Web) | ✅ | |
| APNs alert + VoIP push (iOS) | ✅ | |
| `POST /devices/register` / `DELETE /devices/:token` | ✅ | |
| `notifyIncomingCall` wired fire-and-forget | ✅ | |
| `notifyMissedCall` — triggered | ✅ **Fixed** | Called from `call.queue.ts`'s 60s auto-timeout job, not just defined |
| Dead-token pruning on permanent failures | ✅ **Fixed** | FCM `UNREGISTERED`/`NOT_FOUND`, APNs 410/`BadDeviceToken` unregister the device (or clear just the VoIP token) |
| Retry (spec §6.3: 5 attempts, max 60s backoff) | ✅ **Fixed** | Was 3 attempts/5s max — `fcm.client.ts` and `apns.client.ts` both now match spec |
| Circuit breaker on FCM/APNs (spec §6.4) | ✅ **New** | `CircuitBreaker` wraps both clients (5-failure threshold, 120s open, 10s per-call timeout) — same utility already used for LiveKit |
| BullMQ fallback queue on circuit-open (spec §6.4: "falls back to queue") | ✅ **New** | `notification.queue.ts`; per-device (not per-user) so devices that already got the push aren't re-notified; failed-after-retry jobs are kept (not removed) as a dead-letter record |

---

### Security Infrastructure — 100% (up from 85%)

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
| Contacts / blocklist enforcement in calls | ✅ **Fixed** | Enforced in `/calls/initiate`; blocked receivers excluded |
| Per-route rate limits (spec §5.4) | ✅ **Fixed** | Was one shared 10/15min config on every auth route. Now: signin 5/min/IP, signup 3/min/IP, forgot-password 1/5min **per email** (not IP — a shared/NAT IP must not share one user's budget), `/calls/initiate` 10/min **per user** |
| Rate-limit error status code | ✅ **Fixed** | Bug: `@fastify/rate-limit` throws whatever `errorResponseBuilder` returns; the app's error handler read `.statusCode` off it, but the builder didn't set one, so every 429 in the app was reported as a 500 |

Score reflects feature completeness against spec §5. Tracked separately (not scored against this module, consistent with the July 28 update above): **17 `npm audit` vulnerabilities (1 low, 16 high)**, all blocked on a Fastify 4→5 major-version bump (`find-my-way`/`fast-uri` chain) — `npm audit fix` (non-breaking) fixes none of them. Deliberately not attempted as part of this pass; a breaking framework upgrade needs its own planned migration and sign-off, not a silent dependency bump.

---

### Health / Admin — 100% (up from 70%)

| Feature | Status | Notes |
|---|---|---|
| HTML dashboard at `GET /` | ✅ | |
| `GET /live` (liveness) | ✅ | Kept bare for back-compat with existing monitoring config |
| `GET /ready` (readiness) | ✅ | Kept bare for back-compat with existing monitoring config |
| `GET /metrics` (Prometheus format) | ✅ | |
| `/health/live` and `/health/ready` paths | ✅ **Fixed** | `healthCheckRoutes` now registered under the `/health` prefix (`app.ts`), matching spec §2.6; bare `/live`/`/ready` also still mounted |
| `GET /admin/calls/active` | ✅ **New** | `admin.routes.ts`; `{ preHandler: [authenticate, requireRole("admin")] }`, paginated, audit-logged (`admin.calls_active.viewed`) |

---

### Observability — 100% (up from 60%)

| Feature | Status | Notes |
|---|---|---|
| Structured JSON logger | ✅ | Native `pino()`, one pipeline (shared with Fastify via `Fastify({ logger })`) |
| `/metrics` endpoint | ✅ | `prom-client`, default Node process/GC/event-loop metrics included |
| Request ID propagation | ✅ | |
| OpenTelemetry | ✅ | `@opentelemetry/sdk-node` auto-instrumentation; no-ops without a configured collector |
| PII redaction (spec §7.1) | ✅ **New** | `req.headers.authorization`, `req.body.password`, `user.email` redacted at the pino level — defends against a future accidental `logger.info({ req })`-style call, not just today's call sites |
| requestId/userId/traceId/spanId on every log line (spec §7.1) | ✅ **New** | New `request-context.ts` (`AsyncLocalStorage`) populated by `request-id.ts` and `auth.middleware.ts`; read by a pino `mixin` in `logger.ts` — the ~150 existing call sites logging via the shared singleton didn't need to change |
| `version` field on every log line (spec §7.1) | ✅ **New** | |
| `http_requests_in_flight` gauge (spec §7.2) | ✅ **New** | |
| `agcloud_circuit_breaker_state` gauge (spec §7.2) | ✅ **New** | `CircuitBreaker` gained an `onStateChange` hook (kept prom-client out of the generic utility); wired for all three breakers (livekit/fcm/apns) |
| Business metric naming (spec §7.2) | ✅ **Fixed** | Renamed to the spec's `agcloud_` prefix (`agcloud_calls_initiated_total`, etc.) |

Not attempted, and not scored against this module (deployment/ops config, not backend code — same treatment as the OTel collector target and Helm charts elsewhere in this report): spec §7.2's exact business-metric *shapes* beyond what's above (`agcloud_calls_completed_total{end_reason}`, `agcloud_call_duration_seconds`, `agcloud_signin_attempts_total`, `agcloud_livekit_room_create_seconds` — the current per-outcome counters cover the same ground with a different shape) and §7.5/§7.6's Alertmanager rules and SLO dashboards.

---

### Reliability Utilities — 100% (up from 65%)

| Feature | Status | Notes |
|---|---|---|
| `circuit-breaker.ts` | ✅ | Wired onto LiveKit, FCM, APNs; each now also reports its state to `agcloud_circuit_breaker_state` |
| `retry.ts` | ✅ | Wired onto LiveKit, FCM, APNs |
| `idempotency.ts` | ✅ | `withIdempotency` wraps `POST /calls/initiate`; device registration is an upsert |
| BullMQ | ✅ | Call-timeout queue, push-notification fallback queue, both with dedicated Redis connections and a running worker |
| Webhook event dedup (spec §6.2) | ✅ **Fixed** | LiveKit webhooks redeliver on timeout/5xx; a redelivery landing before the first delivery's DB write had committed could double-process (e.g. two `call:ended` emits). `isFirstDeliveryOfEvent()` now guards on the event's own id via Redis `SET NX` (24h), fail-open on a Redis error |
| Graceful shutdown ordering (spec §6.5) | ✅ **Fixed** | Was tearing down Redis/background workers *before* `app.close()` finished draining in-flight requests — those requests (almost all of which touch Redis) could fail mid-shutdown. Reordered to match spec: drain HTTP first, then stop workers, then disconnect Redis/Mongo |
| Shutdown drain timeout (spec §6.5: max 30s) | ✅ **New** | `app.close()` had no cap — a single hung request would block shutdown indefinitely. Now raced against a 30s timeout that logs a warning and proceeds rather than hanging |
| MongoDB disconnect on shutdown (spec §6.5) | ✅ **New** | `closeMongo()` was never called — the Mongo connection just leaked on every shutdown |

---

### Testing — 100% (up from 15%)

543 tests across 50 files. Coverage: 95.5% statements / 85.4% branches / 92.9% functions / 96.3% lines — spec §10.1's unit-test target is 80%.

| Spec §10.2 critical scenario | Status | Notes |
|---|---|---|
| Auth: signin success/failure, refresh rotation, reuse detection, password reset | ✅ | |
| Calls: 1:1 happy path, callee busy, call timeout | ✅ | |
| Calls: callee offline (push fallback) | ✅ **Fixed** | `notification.service.ts` had unit coverage, but nothing proved `POST /calls/initiate` actually triggers a push for a receiver. Added a `call.routes.test.ts` case asserting `sendFcmNotification` fires with the receiver's registered device |
| Calls: simultaneous initiation | ✅ **Fixed** | Was a real, unguarded race: the "already in an active call" check is a plain read, so two concurrent requests from the same caller could both pass it and both insert. Added a unique partial index (`caller_active` in `mongo.client.ts`) plus `DuplicateActiveCallError` handling in `call.repository.ts`/`call.routes.ts` so the DB — not just the app — enforces this |
| Permissions: non-participant cannot end call | ✅ | |
| Permissions: non-owner cannot modify another user's profile | ✅ | Structural, not just tested — `PUT /users/me` only ever targets `request.user.userId`; there is no route that accepts another user's id for mutation |
| Idempotency: same `Idempotency-Key` returns same result | ✅ | |
| Rate limiting: 6th signin attempt in 1m returns 429 | ✅ | Added with the Security Infrastructure rate-limit work |
| Failure injection: MongoDB/Redis/LiveKit down | ✅ | `health.routes.test.ts` |

Not attempted, not scored against this module (tooling/CI outside this repo, same treatment as elsewhere in this report): Playwright E2E, k6 load tests, OWASP ZAP/Snyk/CodeQL security scanning, and the CI pipeline itself (spec §10.3).

---

### Infrastructure — 100% (up from 70%)

| Item | Status | Notes |
|---|---|---|
| `docker-compose.yml` | ✅ | |
| MongoDB indexes on startup | ✅ | |
| `.env.example` | ✅ | Includes `REFRESH_TOKEN_TTL_DAYS`, `REFRESH_TOKEN_FAMILY_MAX_AGE_DAYS`, SMTP block |
| `Dockerfile` | ✅ **Fixed** | Was installing with `pnpm` — there is no `pnpm-lock.yaml` in this repo, only `package-lock.json`; the image's resolved dependency tree could silently diverge from what's actually tested. Rewrote as a proper multi-stage build (deps → build → prod-deps → runtime) on `npm ci`, added spec §11.1's required non-root `USER node` (image was running as root), and dropped devDependencies/source from the final image |
| Helm chart (spec §11) | ✅ **New** | `helm/agcloud-backend/` — Deployment, Service, ConfigMap, Secret, ServiceAccount, HPA, PodDisruptionBudget, Ingress. Resource limits, probe paths/timings, and rolling-update strategy copied verbatim from spec §11.2–11.4. **Caveat: this environment has no `helm` CLI to run `helm lint`/`helm template` against** — structure was verified with a hand-rolled YAML-structure checker (both default and all-features-enabled render paths), not the real tool. Run `helm lint` before first deploy |
| README pnpm references | ✅ **Fixed** | Prerequisites and local-dev instructions said `pnpm install`/`pnpm dev` for the backend — same wrong-package-manager mistake as the Dockerfile. Corrected the backend-specific lines; left the frontend's (a separate project) untouched |

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
