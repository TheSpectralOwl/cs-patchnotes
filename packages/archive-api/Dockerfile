FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/archive-api/package.json packages/archive-api/
RUN npm ci --ignore-scripts

COPY packages/archive-api packages/archive-api
RUN npm run build -w @cs-patchnotes/archive-api

FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/archive-api/package.json ./packages/archive-api/
COPY --from=build /app/packages/archive-api/dist ./packages/archive-api/dist

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/archive-api/dist/index.js"]
