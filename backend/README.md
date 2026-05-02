# agcloud Backend

This backend is the core business logic layer for the LiveKit-based `agcloud` architecture.

## Purpose
- Authenticate users and generate access tokens
- Manage call life cycle (ringing, accept, active, ended)
- Persist users, calls, and call history in MongoDB
- Track real-time state in Redis
- Receive LiveKit webhooks for participant and room events
- Handle notifications and billing/business rules

## Recommended structure
- `src/`
  - `index.ts` — application entry point
  - `routes/` — Fastify route definitions
  - `modules/` — domain modules: auth, calls, livekit, notifications
  - `services/` — adapters for MongoDB, Redis, LiveKit, push notifications
  - `schemas/` — request/response validation
- `config/`
  - `default.ts`
  - `schema.ts`
- `tests/` — unit and integration tests
- `.env.example` — environment variable template

## Key integrations
- LiveKit: room creation, token generation, egress control, webhook handling
- MongoDB: users, rooms, calls, call history, subscriptions
- Redis: presence, active calls, pub/sub coordination

## Environment variables
- `PORT=3000`
- `MONGO_URI=mongodb://mongo:27017/agcloud`
- `REDIS_URL=redis://redis:6379`
- `LIVEKIT_API_KEY=`
- `LIVEKIT_API_SECRET=`
- `LIVEKIT_URL=http://livekit:7880`
- `JWT_SECRET=`

## Local development
1. Install dependencies: `pnpm install`
2. Copy environment file: `cp .env.example .env`
3. Start the service: `pnpm dev`

## Architecture summary
The backend is intentionally lightweight. It does not handle media or WebRTC signaling directly.
- API routes authenticate users and create calls
- LiveKit tokens are issued by the backend and consumed by clients
- The LiveKit server handles all room signaling, SFU media path, TURN, and recording
- Webhooks keep backend state in sync with LiveKit events
