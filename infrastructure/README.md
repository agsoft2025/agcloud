# Infrastructure

This folder contains the deployment configuration and operational scaffolding for `agcloud`.

## Purpose
- Configure LiveKit server deployment
- House Kubernetes Helm charts for later production rollout
- Document proxy and routing requirements for the LiveKit-based architecture

## Directory layout
- `livekit/` — LiveKit configuration files and local runtime environment
- `helm/` — Helm chart scaffolding for backend, frontend, and LiveKit

## Architecture summary
- The backend serves HTTPS API traffic through a reverse proxy
- LiveKit signaling is proxied via TCP/WSS
- WebRTC media (UDP) bypasses the proxy and connects directly to the LiveKit server
- Redis is used for LiveKit node coordination and shared state
- MongoDB stores persistent application data

## Deployment notes
- Use Caddy or Nginx for local and single-region deployment
- Use a cloud load balancer and WAF for production
- Allow UDP ports `7881` and `50000-60000` directly to LiveKit nodes
- Proxy only `/api/*` and LiveKit signaling; do not proxy RTP/UDP media
