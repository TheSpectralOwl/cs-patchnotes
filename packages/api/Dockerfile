# Multi-stage, native-addon-safe image for @cs-patchnotes/api.
# Build context = repo root (see docker-compose.yml: build.context = ".").
#
# Debian bookworm-slim (glibc), NOT Alpine (musl): keeps the pattern safe for
# better-sqlite3 arriving later — its prebuilt binaries target glibc, so a
# musl base would force a from-source rebuild. Node is pinned to 22 regardless
# of the host's installed Node version, so the image is reproducible across
# machines. No ARG/ENV secrets and no COPY of any .env — secrets are injected
# at runtime by compose, never baked into the image.

# ---- build stage ----
FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app

# Copy only manifests first so `npm ci` is layer-cached across source changes.
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/

# Install the whole workspace at the root; native prebuilds match this base image.
RUN npm ci

# Copy the rest of the sources and build shared first, then the api.
COPY . .
RUN npm run -w packages/shared build \
 && npm run -w packages/api build

# ---- runtime stage ----
FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Carry only what the runtime needs — no build toolchain, no TS sources.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/api/package.json ./packages/api/

# Run as the built-in non-root `node` user (uid 1000) — mitigates privilege
# escalation if the process is compromised (T-00-05).
USER node
EXPOSE 3000

# Health signal keys off the app's own /health endpoint; Debian slim ships Node's
# native fetch so no extra tooling is needed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/api/dist/index.js"]
