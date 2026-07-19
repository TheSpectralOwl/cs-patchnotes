# Multi-stage, native-addon-safe image for @cs-patchnotes/pipeline (the poller).
# Build context = repo root (see docker-compose.yml: build.context = ".").
#
# Debian bookworm-slim (glibc), NOT Alpine (musl): better-sqlite3 ships prebuilt
# binaries that target glibc, so a musl base would force a slow from-source
# rebuild of the native addon. Node is pinned to 22 regardless of the host's
# installed version, so the image is reproducible across machines. No ARG/ENV
# secrets and no COPY of any .env — secrets are injected at runtime by compose,
# never baked into the image.
#
# Unlike the api image this is a run-on-demand CLI, not a listener: it has no
# EXPOSE and no HEALTHCHECK. Compose invokes it as a one-shot
# (`docker compose run --rm poller poll` / `... reindex`), so it exits after the
# stage completes rather than staying up.

# ---- build stage ----
FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app

# Copy only manifests first so `npm ci` is layer-cached across source changes.
COPY package.json package-lock.json ./
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/shared/package.json packages/shared/

# Install the whole workspace at the root; native prebuilds match this base image.
RUN npm ci

# Copy the rest of the sources and build shared first, then the pipeline.
COPY . .
RUN npm run -w packages/shared build \
 && npm run -w packages/pipeline build

# ---- runtime stage ----
FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Carry only what the runtime needs — no build toolchain, no TS sources.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/pipeline/dist ./packages/pipeline/dist
COPY --from=build /app/packages/pipeline/package.json ./packages/pipeline/

# Run as the built-in non-root `node` user (uid 1000) — mitigates privilege
# escalation if the process is compromised.
USER node

# The single CLI entrypoint dispatches the poll | parse | reindex | rebuild
# subcommands (e.g. `docker compose run --rm poller poll`). No EXPOSE/HEALTHCHECK:
# this is a run-on-demand batch job, not a long-lived service.
CMD ["node", "packages/pipeline/dist/cli.js"]
