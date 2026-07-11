# agcloud Backend — Prioritized Remediation Plan

**Date:** 2026-07-11
**Method:** Verified against actual source (`src/`), not against the June 28 status doc, which is now stale relative to `dev` (last commit `6e7a343`, 2026-07-10). Every finding below cites the file and behavior observed.

---

## Two findings not visible in the progress table

### A. The refresh token system is a replay vulnerability, not just "incomplete" (Auth, 88%)

`POST /auth/refresh` (`auth.routes.ts:168-202`) does this:

```ts
decoded = jwt.verify(existingToken, config.jwtSecret, { ignoreExpiration: true });
...
const token = signToken(user._id.toString(), user.email);
```

It takes *any* JWT with a valid signature — expired or not — and re-signs a fresh 15-minute token. There is no separate opaque refresh token, no DB-stored token record, no rotation, no family, nothing to revoke.

`POST /auth/signout` (`auth.routes.ts:205-208`) only calls `reply.clearCookie(...)`. It does not touch the JWT itself.

Consequence: a JWT captured once (XSS, log leak, MITM before HTTPS, shared device) remains valid **forever**, because whoever holds it can call `/auth/refresh` indefinitely to mint new 15-minute tokens — including after the legitimate user has "logged out." The 15-minute access-token expiry gives no real protection since refresh never checks revocation. This is worse than the "7-day non-revocable token" bug from the original spec review — it's now an infinitely-lived, silently-renewable session with no server-side kill switch.

This is the top-priority item in this plan, above everything in the table.

### B. The Dockerfile does not build

`Dockerfile:17-18`:
```
 /c/Users/venkat/.ssh/id_ed25519
 ssh-add $env:venkat\.ssh\id_ed25519
```

These are leftover pasted shell lines with no Dockerfile instruction keyword. Docker's parser requires every non-comment line to start with an instruction (`FROM`, `RUN`, `COPY`, ...). A bare path is parsed as an attempted instruction and fails immediately: `unknown instruction: /C/USERS/VENKAT/.SSH/ID_ED25519`. `docker build` will not produce an image at all right now — this isn't cosmetic noise, it's a hard blocker on every container build, and by extension on `docker-compose up` and any CI/CD pipeline that builds this image. Two-line deletion, but it needs to happen before anyone assumes Sprint work can be containerized.

---

## Everything else, verified against the table

| Table item | Verified in code | Where |
|---|---|---|
| Refresh rotation missing | Confirmed, worse than stated (see A) | `auth.routes.ts` |
| Call cancel/timeout/busy missing | Confirmed. `getActiveCallForUser` already checks caller/callee/receiverIds generically but is only invoked for the *caller* in `/calls/initiate` — the busy-check fix is a ~10-line loop reusing existing infra, not new plumbing | `call.routes.ts:96-103`, `call.repository.ts:193-203` |
| LiveKit critical bugs resolved | Confirmed. Raw-body HMAC verification works, `getLiveKitPublicUrl()` used instead of internal URL, `room_finished`/`participant_joined`/`participant_left`/`egress_ended` all handled | `livekit.routes.ts` |
| Contacts/blocklist missing | Confirmed. No `/users/me/contacts` or `/block` routes exist | `user.routes.ts` |
| Presence Redis-backed | Confirmed, well-built — hash + socket set + grace-period key + cross-instance pub/sub | `presence.service.ts`, `presence.repository.ts` |
| Presence not contact-scoped | Confirmed — the pub/sub subscriber does `io.emit(event.event, event)` unconditionally, broadcasting to every connected socket | `presence.service.ts:64` |
| No Socket.IO rate limiting | Confirmed — `io.use()` only verifies the JWT, no per-IP connection cap, no per-event throttling | `realtime.service.ts:67-89` |
| Push fire-and-forget | Confirmed. `notifyIncomingCall`/`notifyMissedCall` use `Promise.allSettled` and never prune devices on permanent failure (e.g., FCM `UNREGISTERED`) — dead tokens accumulate forever and get retried on every call | `notification.service.ts`, `fcm.client.ts` |
| `/live` `/ready` path mismatch | Confirmed — `healthRoutes` registered with no prefix in `app.ts:101`; routes live at `/live` and `/ready`, not `/health/live` | `app.ts:101`, `health.routes.ts:184,186` |
| Audit logging missing | Confirmed — zero references to any audit collection or audit logger anywhere in `src/` | grep, whole tree |
| Not Pino / prom-client, no OTel | Confirmed. `logger.ts` hand-rolls a JSON logger with pino's exact API shape instead of using the `pino` dependency already in `package.json` — and Fastify is *separately* running its own real pino instance internally (`app.ts:48-52`), so there are two divergent logging pipelines. `metrics.ts` hand-rolls Prometheus text format with unbounded in-memory label maps (no cardinality guard). `tracing.ts` is a request-ID UUID hook; its own comment says to replace it with `@opentelemetry/sdk-node` | `logger.ts`, `metrics.ts`, `tracing.ts` |
| Circuit breaker / retry / idempotency built, not wired | Confirmed — all three are complete, well-written, production-quality utilities. Grep shows zero call sites outside their own files. LiveKit calls, FCM/APNs sends, and `/calls/initiate` currently have no breaker, no retry, no idempotency protection despite the code existing to provide all three | `circuit-breaker.ts`, `retry.ts`, `idempotency.ts` |
| Testing 15% | Confirmed — `test/` has only `auth.routes.test.ts` and `cors.test.ts`; `src/modules/auth/__tests__/` is empty; no call/user/realtime/LiveKit tests exist | `test/`, `src/modules/auth/__tests__/` |
| Dockerfile SSH artifact | Confirmed present, and confirmed build-breaking (see B) | `Dockerfile:17-18` |

Also worth noting, not in the table: MongoDB indexing is actually in good shape — unique email index, sparse reset-token index, compound call-history indexes by caller/callee/receiver + `createdAt`, call-status index, device uniqueness index (`mongo.client.ts:30-53`). No action needed there.

---

## Sequenced plan

### Sprint 0 — Unblock, same day, no dependencies
1. Delete `Dockerfile:17-18`. Confirm `docker build` succeeds.
2. Callee-busy check: loop `receiverIds` in `POST /calls/initiate`, call the existing `callRepo.getActiveCallForUser(receiverId)` for each, and skip/flag any receiver already on an active call instead of silently ringing a second call. No new repository method needed.

### Sprint 1 — Session security (highest severity, do not ship further features on top of the current auth model)
3. Replace `/auth/refresh` with a real refresh-token system: opaque random refresh token (256-bit), stored **hashed** (SHA-256) in a `refresh_tokens` collection keyed by a token-family ID; rotate the token on every use; if a used/rotated token is presented again, treat it as theft and revoke the entire family.
4. Make `/auth/signout` actually revoke — invalidate the refresh-token family server-side, and maintain a short Redis denylist of revoked access-token `jti`s (cheap, since access tokens are already 15 minutes, so the denylist entry only needs a matching TTL).
5. "Logout everywhere" = revoke all refresh-token families for a user; "device sessions" = list active families with device/user-agent metadata captured at issuance.
6. Minimal audit logging: write to an `audit_logs` collection on signin, signout, failed login, password reset, and refresh-token reuse detection. This is what turns finding A from "silent forever" into "detectable."

### Sprint 2 — Call lifecycle correctness
7. `POST /calls/:id/cancel` — distinct from `/end`; only valid pre-accept (`status: "initiated"`), emits `call:cancelled` (not `call:ended`) so clients can distinguish "caller hung up before you answered" from "call that was live just ended."
8. 60-second unanswered-call timeout — use BullMQ (Redis is already a runtime dependency) with a delayed job scheduled at call-initiate time; on fire, check status is still `initiated`, transition to `missed` (already a valid transition in `CallStateMachine`), mark pending participants missed, fire `notifyMissedCall`. Prefer this over `setTimeout` — it survives process restarts and horizontal scaling, `setTimeout` doesn't.
9. Wire `withIdempotency` (already built) onto `/calls/initiate` to absorb client retries/double-taps that would otherwise create duplicate call records.

### Sprint 3 — Contacts, blocklist, presence privacy
10. Contacts CRUD (`GET/POST/DELETE /users/me/contacts`).
11. Blocklist (`POST /users/me/block/:id`), enforced as a check in `/calls/initiate` — reject if caller is blocked by any receiver.
12. Scope the `presence:update`/`USER_ONLINE`/`USER_OFFLINE` broadcast (`presence.service.ts:64`) to the target user's contacts instead of `io.emit` to everyone — this is now possible once #10 exists.

### Sprint 4 — Reliability wiring (cheap, the hard part is already built)
13. Wrap `livekit.service.ts` calls (`createLiveKitToken`, `endLiveKitRoom`, `startRoomRecording`, `checkLiveKitHealth`) in a `CircuitBreaker` instance so a LiveKit outage degrades gracefully instead of hanging every call-related request.
14. Wrap FCM/APNs sends in `withRetry` with a `retryOn` predicate that retries transient errors (5xx, network) but not permanent ones (invalid token).
15. On a permanent push failure (FCM `UNREGISTERED`, APNs `410`), call the existing `unregisterDevice` to stop retrying dead tokens forever.
16. Rate-limit Socket.IO connections (per-IP cap at handshake) and consider per-event throttling on high-frequency events like `PING`.

### Sprint 5 — Observability consolidation
17. Delete the hand-rolled `logger.ts`; use the `pino` dependency directly (share a single instance with Fastify's internal one via `app.log`, or construct one `pino()` instance and pass it in) — one logging pipeline, not two.
18. Replace `metrics.ts` with `prom-client` — get default Node.js process/GC metrics for free and remove the unbounded in-memory label-map growth risk.
19. Add `@opentelemetry/sdk-node` with auto-instrumentation for Fastify, MongoDB, Redis, and outbound HTTP (LiveKit/FCM/APNs) so traces correlate across all four external dependencies, not just a request-ID string.

### Sprint 6 — Testing (should track each sprint above, not trail behind)
20. Call lifecycle tests: state machine transitions, cancel, timeout, busy-check.
21. Realtime tests: socket auth rejection, presence-broadcast scoping (once #12 lands).
22. LiveKit webhook tests: valid HMAC, invalid HMAC, missing header in prod vs. dev bypass.
23. Integration suite against real Mongo + Redis via Testcontainers, replacing the current unit-only coverage.

---

## Why this order

Sprint 0 items have zero dependencies and unblock everything downstream (you cannot even build a container right now). Sprint 1 comes before any new feature work because every other fix in this plan sits on top of an auth model that currently cannot revoke a stolen session — shipping contacts, blocklist, or call features without fixing that first just gives an attacker more to do with a session they can never lose. Sprints 2 and 3 are independent of each other and of Sprint 4/5, so they can run in parallel with different engineers if you have the headcount. Sprint 3's presence-scoping step (#12) is hard-blocked on contacts (#10) existing, so don't reorder those two. Sprints 4 and 5 are pure infrastructure investment with no user-facing dependency — good filler work for whenever a sprint has slack, but shouldn't be prioritized over Sprint 1.
