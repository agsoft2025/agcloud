# agcloud-backend Helm chart

Deploys the agcloud backend (Fastify API + Socket.IO + LiveKit webhook
receiver) per `documents/Backend-Specification.md` §11 (Deployment).

## Prerequisites

- Kubernetes 1.25+
- Helm 3.8+
- MongoDB and Redis reachable from the cluster (not deployed by this chart —
  bring your own, per spec's assumption of managed/external data stores)
- A container image already built and pushed (see the repo's `Dockerfile`);
  this chart does not build one

## Quick start

```bash
# 1. Copy and fill in real values — DO NOT commit this file.
cp values.yaml values-mine.yaml

# 2. Install
helm upgrade --install agcloud-backend ./agcloud-backend \
  -f values-mine.yaml \
  --set image.repository=ghcr.io/your-org/agcloud-backend \
  --set image.tag=$(git rev-parse --short HEAD) \
  -n agcloud --create-namespace
```

## Secrets

`values.yaml`'s `secrets.data` block is a convenience default for
local/staging: Helm renders it straight into a Kubernetes `Secret`
(base64-encoded, **not** encrypted at rest by that alone). For anything
beyond that, don't populate `secrets.data` — instead:

1. Create the Secret out-of-band (External Secrets Operator, Vault, your
   cloud provider's secret manager — see spec §5.6) with the same key names
   listed in `values.yaml`.
2. Set `secrets.create: false` and `secretRef: <that-secret-name>`.

## What this chart does NOT include

Scoped to what spec §11 actually specifies. Deliberately out of scope:

- **MongoDB / Redis** — spec assumes external/managed instances, not
  in-cluster StatefulSets.
- **LiveKit server** — a separate service (`config.livekitUrl` points at it,
  in-cluster or LiveKit Cloud).
- **Alertmanager rules / Grafana dashboards** (spec §7.5–7.6) — cluster-wide
  observability config, not per-app.
- **CI pipeline** (spec §10.3) — lives in the repo's CI config, not here.
- **Canary rollout automation** (spec §11.4) — this chart does a plain
  rolling update; canary staging (5% → 25% → 50% → 100% with automatic
  rollback) needs a progressive-delivery controller (Argo Rollouts / Flagger)
  layered on top, which spec itself frames as "Helm **or** Argo CD" — an
  operational choice, not something to hardcode here.

## Validating changes

This environment doesn't have the `helm` CLI installed, so these templates
were hand-written against Helm's documented template syntax and existing
chart conventions, not verified with `helm lint` / `helm template`. Before
first deploying, run both from a machine with Helm installed:

```bash
helm lint ./agcloud-backend
helm template ./agcloud-backend -f values-mine.yaml | less
```
