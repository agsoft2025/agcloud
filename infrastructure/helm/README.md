# Helm Charts

This directory will hold Kubernetes Helm charts for the `agcloud` stack.

## Expected charts
- `backend/` — Node.js backend service
- `frontend/` — SvelteKit web application
- `livekit/` — LiveKit server deployment
- `proxy/` — Caddy/Nginx ingress and routing

## Goals
- Provide a repeatable production deployment path
- Separate configuration from code
- Support multi-region, multi-AZ rollout patterns
- Enable easy overrides for secrets, resource limits, and ingress

## Notes
- Start with local Docker Compose for MVP
- Add Helm only once the deployment design is stable
- Keep LiveKit and backend chart values aligned with `infrastructure/livekit/livekit.yaml`
