# Spec §11.1: multi-stage build, non-root user, minimal final image.

# ---- deps: install once, reused by both the build and prod stages ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript -> dist/ -------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- prod deps: production-only node_modules, no devDependencies -----------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: final image — only what's needed to run node dist/index.js ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# node:20-alpine already has a non-root "node" user (uid/gid 1000) —
# spec §11.1 requires the container not run as root.
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
