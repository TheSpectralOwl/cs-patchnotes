<!-- GSD:project-start source:PROJECT.md -->

## Project

**CS Patch Notes Archive**

A searchable archive of every Counter-Strike patch note (CS:GO + CS2), with full-text search, faceted filters, and auto-generated tags. It's for CS players who want to answer "when did X change?" fast — pulling official patch notes from Valve's Steam News feed into one clean, browsable reference.

**Core Value:** A player can search across all CS:GO/CS2 patch notes and instantly find when and how a specific thing changed. If everything else fails, search-over-the-full-corpus must work.

### Constraints

- **Data integrity:** SQLite is the single source of truth; the Meilisearch index is a disposable cache, always rebuildable from SQLite.
- **Idempotency:** Ingestion, parsing, and classification must be idempotent and re-runnable (upserts, no dupes).
- **Separation of passes:** Classification/tagging is a separate re-runnable pass from ingestion — raw notes stay pristine; tags stored separately, never baked into ingestion.
- **Security:** Secrets (Anthropic API key, Meili master key) live in env / GitHub Secrets, never in the repo. Meilisearch is never publicly exposed (reached only via the backend proxy over the internal network).
- **Steam API quirks:** Use `maxlength=0` for full bodies; handle BBCode, `{STEAM_CLAN_IMAGE}` placeholders, emojis, and inconsistent bracket usage across years; filter to real patch notes via `feedlabel`/`feedname` (drop marketing/esports posts).
- **Branch hygiene:** `main` is merge-via-PR only (enforced by GitHub branch protection: PR required, 0 approvals, force-push/deletion blocked). Work happens on feature branches, lands via `/gsd-ship` PRs.
- **Planning artifacts:** `.planning/` is git-ignored (`commit_docs: false`) — ephemeral planning docs are not committed.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Node.js** | 22 LTS (`22.x`, "Jod") | Runtime for pipeline + API | Active LTS through 2027; native `fetch`, `--env-file`, stable `node:test`. Use 22, not 24 (still "Current") — better-sqlite3/native-addon ecosystem is most battle-tested on LTS. |
| **TypeScript** | `5.9.x` | Language | Locked. Strict mode + `zod` gives an end-to-end typed pipeline, shared with the frontend. |
| **Fastify** | `5.10.x` | Thin proxy/read API | Best fit for a *thin proxy*: first-class TS types, schema-based (JSON Schema/`zod`) validation & serialization, built-in `pino` logging, `@fastify/*` plugin ecosystem (cors, rate-limit, helmet, under-pressure). Faster than Express, more "batteries-included" than Hono for a Node-on-a-VPS deploy. |
| **better-sqlite3** | `12.11.x` | SQLite driver (source of truth) | Synchronous API is the right call for this workload: a tiny corpus, a batch pipeline, and idempotent upserts. Synchronous = simplest correct code, transactions via `db.transaction()`, fastest for local disk. No async ceremony where none is needed. |
| **Meilisearch (server)** | `v1.49.x` | Search engine (self-hosted) | Locked. Purpose-built typo-tolerant full-text + faceting/filtering; trivial Docker deploy; index is a disposable cache rebuildable from SQLite. |
| **meilisearch (JS SDK)** | `0.59.x` (npm pkg name `meilisearch`) | Meili client, used **server-side only** | Locked proxy decision → SDK runs inside the API with the master/admin key; the browser never talks to Meili. SDK guarantees compat with server v1.x. |
| **@anthropic-ai/sdk** | `0.112.x` | Haiku classification via Batch API | Official TS SDK. `client.messages.batches.*` covers create/poll/stream-results. 50% cost via Batch is ideal for the infrequent, non-latency-sensitive classification pass. |
| **@tanstack/react-router** | `1.170.x` | Frontend routing (SPA) | Locked TanStack. Use **Router (SPA mode)**, NOT Start — see "What NOT to Use". Type-safe search-param APIs (`validateSearch`, `useSearch`) make filter/query state URL-addressable, which is exactly what a faceted search UI needs. |
| **@tanstack/react-query** | `5.101.x` | Server-state / search fetching | Caches search + facet requests, dedupes, handles loading/error/stale states, `keepPreviousData` for smooth typeahead. Pairs with Router search params as the query key. |
| **cloudflared** | image `cloudflare/cloudflared:latest` (pin a dated tag, e.g. `2025.x`) | Ingress tunnel | Locked. Remote-managed **token** tunnel — HTTPS with zero open inbound ports, no cert management. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **zod** | `4.4.x` | Runtime validation + inferred types | Validate Steam API responses, API query params (via `fastify-type-provider-zod`), and — critically — the strict JSON schema Haiku must return for classification. |
| **pino** | `10.3.x` | Structured logging | Built into Fastify; use `pino-pretty` in dev. Structured logs matter for the poller + batch pipeline on the VPS. |
| **@fastify/cors** | `11.3.x` | CORS for the SPA origin | The SPA is served from Cloudflare Pages (different origin) → API must allow that origin explicitly. |
| **@fastify/rate-limit** | `10.x` | Rate limiting the proxy | The proxy is load-bearing for all search (locked decision cost). Rate-limit the public `/search` endpoint. |
| **@fastify/helmet** | `13.x` | Security headers | Cheap hardening on the one public surface. |
| **node-html-parser** or **cheerio** | `1.2.x` (cheerio) | BBCode/HTML-entity cleanup | Valve notes mix BBCode + HTML entities + `{STEAM_CLAN_IMAGE}` placeholders. Do BBCode via a small regex/tokenizer; use cheerio only if you need DOM-style entity decoding. Keep parsing deterministic and unit-tested against fixture files. |
| **drizzle-orm** (optional) | `0.45.x` | Typed query builder over better-sqlite3 | ONLY if you want typed migrations + query builder. For a schema this small, hand-written SQL + `better-sqlite3` is defensible. If you adopt it, use Drizzle in **query-builder mode on the better-sqlite3 driver** + `drizzle-kit` for migrations. See Alternatives. |
| **tsx** | `4.x` | Run TS directly in dev/scripts | Zero-config TS execution for pipeline scripts and the poller without a build step. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **Vite** | `8.1.x` | Frontend build/dev server | TanStack Router SPA builds on Vite; use `@tanstack/router-plugin/vite` for file-based routes + codegen. Output is static → Cloudflare Pages. |
| **Biome** or **ESLint 9 + Prettier** | Lint/format | Biome is faster and one-tool; either is fine. Pick one and apply it consistently across the repo. |
| **Vitest** | Unit tests | Pipeline parser edge-cases (14 years of format drift) are the highest-value tests — snapshot-test the parser against real fixture notes from 2013/2018/2023/2026. |
| **docker-compose** | Local + VPS orchestration | One compose file: `meili + api + poller + cloudflared`. No Caddy, no published ports except Meili bound to `127.0.0.1`/internal network only. |
| **GitHub Actions** | CI/CD | Locked. Build/test on push; deploy frontend to Pages; deploy/`compose up` on the Hetzner box; scheduled poll can be Actions cron OR on-box systemd timer (prefer on-box timer so the poller shares the compose network + SQLite volume). |

## Installation

# --- API + pipeline (Node/TS) ---

# optional typed DB layer:

# npm install drizzle-orm && npm install -D drizzle-kit

# --- Frontend (static SPA) ---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **Fastify** (API) | **Hono** | Choose Hono if you later move the API to Cloudflare Workers/edge, or want the smallest possible footprint. But the deploy target is a Node VPS, and the proxy benefits from Fastify's plugin ecosystem (rate-limit, helmet, schema) — so Fastify wins *here*. |
| **Fastify** | **Express 5** | Express 5 (`5.2.x`) is now stable, but offers weaker TS ergonomics and no built-in schema/serialization. Only pick it for maximum familiarity; no advantage for a greenfield thin proxy. |
| **better-sqlite3** | **node:sqlite** (built-in) | Node 22.5+ ships an experimental `node:sqlite`. It's synchronous like better-sqlite3 but still **experimental** and API-unstable — avoid for source-of-truth durability until it stabilizes. Revisit at Node 24 LTS. |
| **better-sqlite3** | **Drizzle ORM** | Adopt Drizzle if you want typed schema + versioned migrations out of the box. It sits *on top of* better-sqlite3, so it's additive, not a replacement of the driver. Worth it if the schema grows; overkill for the MVP's handful of tables. |
| **better-sqlite3** | **Kysely** | Kysely is a superb type-safe query builder but is **async-first** (SQLite via a driver dialect). For a synchronous batch pipeline it adds Promise ceremony with no payoff. Prefer Drizzle if you want a builder; prefer raw SQL for simplicity. |
| **TanStack Router (SPA)** | **TanStack Start** | Start = full-stack SSR/server-functions framework. Only use it if you needed server rendering — but the frontend is a **static SPA on Cloudflare Pages** with search proxied through a separate API. SSR adds a server you don't want. Router in SPA mode is the correct subset. |
| **On-box systemd timer** (poller) | **GitHub Actions cron** | Use Actions cron only if you don't want a long-lived poller container. On-box timer is simpler here because the poller needs the same SQLite volume + Meili network as the API. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **Client-side Meilisearch search-only key** | Violates the locked proxy decision; exposes Meili host + a key to the browser, no central rate-limiting. | Backend proxy: browser → API → Meili (Meili bound to internal network only). |
| **Caddy / nginx reverse proxy + open 80/443** | Dropped by decision. Adds cert management and open inbound ports. | Cloudflare Tunnel (`cloudflared`) — HTTPS, zero open ports. |
| **`instant-meilisearch` / InstantSearch.js widgets** | Designed for the browser to hit Meili directly with a search key — incompatible with the proxy model. | Plain `@tanstack/react-query` calling your `/search` proxy; render facets from Meili's `facetDistribution`. |
| **TanStack Start / Next.js / SSR framework** | Introduces a server runtime the architecture explicitly avoids (static SPA on Pages). | TanStack Router SPA build → static output on Cloudflare Pages. |
| **ORMs with async SQLite drivers (Prisma, Sequelize, Kysely) for the pipeline** | Async overhead and heavier runtime for a tiny local-disk corpus; Prisma's engine is a poor fit for embedded SQLite batch work. | `better-sqlite3` (sync), optionally + Drizzle for typed migrations. |
| **Streaming/non-batch Anthropic calls for bulk classification** | Full-price and latency-bound; classification is not latency-sensitive. | Message Batches API (50% cost, async) with `claude-haiku-4-5`. |
| **`feedlabel`/`feedname` as the *primary* patch-note filter** | Live API check shows these are generic ("Community Announcements"). | Filter on the `tags` array containing `"patchnotes"` (present on real notes; drop marketing/esports); keep feedname as a secondary signal. |
| **`enddate` misunderstood as offset pagination** | Steam's `GetNewsForApp` has no offset param. | Paginate backward through 14 years by passing the oldest item's `date` as `enddate` on the next call, looping until exhausted. |

## Stack Patterns by Variant

- API exposes `GET /search?q=&game=&category=&from=&to=`; validates params with `zod`; calls `index.search(q, { filter, facets, attributesToHighlight, cropLength })` using the SDK with an admin/search key held only on the server.
- Meilisearch container binds to the internal compose network only (no host port, or `127.0.0.1:7700`). The browser never sees the Meili host or any key.
- Configure facets once: `index.updateFilterableAttributes(['game','category','tags','date'])` and `updateSortableAttributes(['date'])` during index build.
- A `reindex` script reads all rows from SQLite and `addDocuments()` in batches keyed by a stable line ID → index is fully reproducible from source of truth.
- Deterministic rules (bracket headers → category, keyword/entity match → tags) handle the majority; only ambiguous lines go to a batch.
- `client.messages.batches.create({ requests: [{ custom_id: lineId, params: { model: 'claude-haiku-4-5', max_tokens, system, messages } }] })`.
- Poll `batches.retrieve(id)` until `processing_status === 'ended'`; stream `batches.results(id)`; match each result to its line by `custom_id` (results are unordered); force a strict JSON schema (category + entity tags only), validate with `zod`, discard/flag anything that doesn't parse. Store tags in a separate table — never baked into ingestion.
- `GET https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&maxlength=0&count=50` (no key). Backfill by looping with `enddate=<oldest date seen>`. Derive game from date (CS2 ≥ 2023-09-27). Upsert by `gid` for idempotency.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `meilisearch@0.59` (SDK) | Meilisearch server `v1.x` (`v1.49`) | SDK README guarantees v1.x compat; keep SDK and server both current. |
| `better-sqlite3@12` | Node `20/22 LTS` | Native addon — prebuilds exist for LTS; build toolchain (`python`, `make`, `g++`) needed only if prebuild missing. Rebuild in the Docker image matching the runtime. |
| `@tanstack/react-router@1.170` | `@tanstack/react-query@5`, React 18/19, Vite 8 | Use `@tanstack/router-plugin/vite`; optional `@tanstack/react-router-ssr-query` only if SSR (not used here). |
| `@anthropic-ai/sdk@0.112` | `claude-haiku-4-5` | Model is active (batch $0.50/$2.50 per MTok). `custom_id` must match `^[a-zA-Z0-9_-]{1,64}$`; `max_tokens >= 1`. |
| `fastify@5` | `@fastify/*` v5-era plugins | Match plugin majors to Fastify 5 (cors@11, rate-limit@10, helmet@13). |
| `cloudflared` image | Cloudflare edge | Supported within 1 year of latest release — pin a recent dated tag and update periodically. |

## Sources

- npm registry `/latest` (live, 2026-07-18) — pinned versions for fastify 5.10, hono 4.12, express 5.2, better-sqlite3 12.11, drizzle-orm 0.45, kysely 0.29, meilisearch 0.59, @tanstack/react-router 1.170, @tanstack/react-query 5.101, @anthropic-ai/sdk 0.112, @tanstack/react-start 1.168, cheerio 1.2, zod 4.4, vite 8.1, pino 10.3, @fastify/cors 11.3 — **HIGH**
- GitHub `meilisearch/meilisearch` releases/latest → server `v1.49.0` — **HIGH**
- docs.claude.com Batch processing guide — TS `messages.batches` create/retrieve/results usage; `claude-haiku-4-5` active + batch pricing; custom_id/max_tokens constraints — **HIGH**
- Live `ISteamNews/GetNewsForApp/v2` call (appid 730, maxlength=0, 2026-07-18) — no key; 1748 items; `tags` includes `"patchnotes"`; BBCode bodies; fields incl. `gid`,`date`(unix),`feedname` — **HIGH**
- meilisearch-js README (main) — SDK class `Meilisearch`, "Using Meilisearch behind a proxy" section (requestConfig headers / custom httpClient), v1.x compat, faceting via `updateFilterableAttributes` — **HIGH**
- cloudflared README (master) — Docker image on DockerHub, token/remote-managed tunnel, no open ports, 1-year support window — **HIGH**
- Note: Brave/Context7 seams were unavailable in this environment (no API key / MCP); findings verified via direct registry, GitHub, official docs, and live API instead — provider fallback per tool_strategy.

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

### No ephemeral planning references in committed code, PRs, or issues

Committed source, config, scripts, pull request titles/descriptions, and
GitHub issues must never reference GSD planning-cycle identifiers in
comments, strings, filenames, env files, or prose. This covers phase/plan
references ("Phase 0", "00-01"), decision references ("D-08"), requirement
references ("OPS-01"), and research references ("Pitfall 3").

**Why:** Planning is ephemeral and re-numberable (`.planning/` is git-ignored,
`commit_docs: false`); the codebase is not. A comment like `// added in Phase 1`
or `// per D-08` goes stale the moment phases get reordered, decisions get
revised, or requirements get renumbered — and a reader with no access to
`.planning/` can't resolve the reference to anything.

**Instead:** Describe the technical rationale in plain English — what has to
be true and why, not which planning artifact says so. Prefer "added once
`packages/pipeline` exists" over "added in Phase 1"; prefer "Meilisearch must
never be reachable from outside the compose network" over "Meilisearch is
private (OPS-01)". PR/issue section headers should describe subsystems or
outcomes ("Docker image + compose stack"), not plan IDs ("Plan 00-02").

**Applies to:** All git-tracked files, plus PR and issue titles/descriptions.
Does not apply to `.planning/` itself (gitignored) or to threat-model IDs
using a phase-number prefix as a stable ID scheme (e.g. `T-00-01`) rather than
a narrative reference — those are durable audit-trail identifiers, not
planning-cycle pointers.

**Enforcement:** Before committing, grep for stray planning references outside
`.planning/`:
```bash
git diff --cached --name-only | grep -v '^\.planning/' | xargs -r grep -inE '\bphase [0-9]|\bD-[0-9]{2}\b|\b(OPS|REQ)-[0-9]{2}\b|\bPitfall [0-9]+\b'
```

See `.planning/CONVENTIONS.md` for full detail.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
