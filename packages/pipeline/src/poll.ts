import type { Database } from "better-sqlite3";
import { openDb, type Channel } from "@cs-patchnotes/shared";
import { ALLOW_LIST, DENY_LIST } from "./overrides.js";

/**
 * The write-side "poll" stage: fetch the newest CS2 update slice from the Steam
 * News API, keep only real patch notes, and upsert their pristine raw bodies
 * into SQLite keyed on the Valve gid (idempotent — re-running produces no
 * duplicates).
 *
 * Separation of concerns: this stage never parses meaning. It stores
 * `raw_body = item.contents` untouched so the corpus can be re-parsed later
 * without re-fetching (the source-of-truth split).
 */

/** One item from `appnews.newsitems` (live-verified shape, 2026 Steam feed). */
export interface SteamNewsItem {
  /** Stable, Valve-assigned id → becomes `update.id`. */
  gid: string;
  title: string;
  url: string;
  /** 1 = Valve community announcement; 0 = third-party press feed. */
  feed_type: number;
  feedname: string;
  /** Unix epoch SECONDS. */
  date: number;
  /** FULL body (BBCode) because the fetch uses `maxlength=0`. */
  contents: string;
  /** Present on real notes AND on marketing — never trust it alone. */
  tags?: string[];
}

/** 2023-09-27T00:00:00Z, in unix epoch seconds — the CS:GO → CS2 cutover. */
const CS2_CUTOVER = Date.UTC(2023, 8, 27) / 1000;

/**
 * The per-era title patterns Valve has used across the corpus. A post whose
 * title matches ANY of these is a real patch note regardless of its body shape.
 *
 * - `^Counter-Strike 2 Update` — the CS2 era.
 * - `^Release Notes? for \d` — the CS:GO era. Note the optional `s`: Valve uses
 *   the singular "Release Note" as well (e.g. "Release Note for 3/8/2024").
 * - `Counter-Strike: Global Offensive Update Released` — CS:GO major updates.
 */
const TITLE_PATTERNS: RegExp[] = [
  /^Counter-Strike 2 Update/,
  /^Release Notes? for \d/,
  /Counter-Strike: Global Offensive Update Released/,
];

/**
 * The two-stage + per-era + override feed filter (the load-bearing discriminator).
 *
 * Stage 1 — source: drop anything that is not a Valve community announcement.
 * Stage 2 — content: accept a post whose title matches any per-era pattern OR
 *   whose gid is human-audited into the allow-list. A gid on the deny-list is
 *   rejected even if its title matches (the audited kill-switch).
 *
 * Live data proves marketing posts carry `feed_type: 1`,
 * `feedname: "steam_community_announcements"`, AND the `patchnotes` tag — so the
 * `tags` array and `feedname` are NOT trustworthy on their own. Title match plus
 * the committed override list is the correct discriminator. Title-matched posts
 * are accepted regardless of body shape — no `[ SECTION ]`/bullet-count gate.
 */
export function isPatchNote(item: SteamNewsItem): boolean {
  if (item.feed_type !== 1 || item.feedname !== "steam_community_announcements") {
    return false; // Stage 1 — source filter
  }
  if (DENY_LIST.has(item.gid)) {
    return false; // audited kill-switch: reject even a title match
  }
  if (item.gid in ALLOW_LIST) {
    return true; // audited off-title real patch note
  }
  return TITLE_PATTERNS.some((re) => re.test(item.title)); // Stage 2 — per-era title
}

/**
 * Derive the release channel for an item. Only allow-listed off-title posts carry
 * a non-mainline channel; every plain title-matched post defaults to `mainline`.
 */
export function channelForItem(item: SteamNewsItem): Channel {
  return ALLOW_LIST[item.gid]?.channel ?? "mainline";
}

/**
 * Derive the game from a post date. The slice is CS2-only this phase, but the
 * derivation is exercised so the `game` column is populated correctly and the
 * cutover logic is proven.
 */
export function gameForDate(postedAt: number): "cs2" | "csgo" {
  return postedAt >= CS2_CUTOVER ? "cs2" : "csgo";
}

/**
 * Filter the given feed to real CS2 patch notes and upsert each into `updates`
 * inside a single transaction. Upsert is keyed on `id = gid` so re-running is
 * idempotent. `raw_body` is stored verbatim (pristine).
 *
 * @returns the number of accepted (upserted) notes.
 */
export function upsertUpdates(db: Database, items: SteamNewsItem[]): number {
  const accepted = items.filter(isPatchNote);
  const fetchedAt = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO updates (id, posted_at, title, url, feedname, game, raw_body, fetched_at, channel)
    VALUES (@id, @posted_at, @title, @url, @feedname, @game, @raw_body, @fetched_at, @channel)
    ON CONFLICT(id) DO UPDATE SET
      posted_at  = excluded.posted_at,
      title      = excluded.title,
      url        = excluded.url,
      feedname   = excluded.feedname,
      game       = excluded.game,
      raw_body   = excluded.raw_body,
      fetched_at = excluded.fetched_at,
      channel    = excluded.channel
  `);

  const tx = db.transaction((rows: SteamNewsItem[]) => {
    for (const it of rows) {
      stmt.run({
        id: it.gid,
        posted_at: it.date,
        title: it.title,
        url: it.url,
        feedname: it.feedname,
        game: gameForDate(it.date),
        raw_body: it.contents, // PRISTINE — never mutate the source of truth
        fetched_at: fetchedAt,
        channel: channelForItem(it),
      });
    }
  });

  tx(accepted);
  return accepted.length;
}

/**
 * Hard fetch guard: a truncated backfill must abort, never silently store a
 * partial corpus. Throws a descriptive Error when the number of items actually
 * received does not equal the number expected.
 */
export function assertReceivedAll(received: number, expected: number): void {
  if (received !== expected) {
    throw new Error(
      `Truncated Steam News fetch: received ${received} item(s) but expected ${expected}. ` +
        `Aborting to avoid storing a partial corpus.`,
    );
  }
}

/**
 * Fetch the newest `count` news items for CS2 (appid 730) with full bodies.
 * `maxlength=0` returns untruncated `contents`. Native `fetch`, no dependency.
 *
 * `appnews.count` is the total number of items the feed holds. When `count`
 * exceeds that total (the backfill case) the response returns every item, so the
 * received length must equal the total or the fetch was truncated. When `count`
 * is smaller (the incremental case) the expected length is `count` itself. The
 * guard uses `min(count, total)` so it catches truncation on both paths without
 * false-tripping the small incremental slice.
 */
async function fetchNewsItems(count: number): Promise<SteamNewsItem[]> {
  const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&maxlength=0&count=${count}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Steam News fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    appnews?: { count?: number; newsitems?: SteamNewsItem[] };
  };
  const items = data.appnews?.newsitems ?? [];
  const total = data.appnews?.count ?? items.length;
  assertReceivedAll(items.length, Math.min(count, total));
  return items;
}

/** Options for {@link pollUpdates} — the fetcher/db seams keep it test-drivable. */
export interface PollOptions {
  db?: Database;
  /** Inject a fetcher (or fixtures) to drive the runner without a network call. */
  fetcher?: () => Promise<SteamNewsItem[]>;
  count?: number;
}

/**
 * Fetch → filter → upsert. The db and fetcher are injectable so tests can drive
 * the whole stage against an in-memory database and fixtures.
 */
export async function pollUpdates(opts: PollOptions = {}): Promise<number> {
  const db = opts.db ?? openDb();
  const count = opts.count ?? Number(process.env.POLL_COUNT ?? 25);
  const fetcher = opts.fetcher ?? (() => fetchNewsItems(count));
  const items = await fetcher();
  return upsertUpdates(db, items);
}

/** CLI entrypoint for `pipeline poll`. */
export async function runPoll(): Promise<void> {
  const accepted = await pollUpdates();
  console.log(`poll: upserted ${accepted} CS2 update(s)`);
}

/** Default backfill fetch size — must exceed the full corpus (~1748 items). */
const BACKFILL_COUNT = 5000;

/** Expected accepted-note reconciliation band (title-matched + allow-list). */
const RECONCILE_MIN = 200;
const RECONCILE_MAX = 275;

/**
 * Options for {@link runBackfill} — mirrors the {@link PollOptions} seam so the
 * large-count path is driven by fixtures with no network in tests.
 */
export interface BackfillOptions {
  db?: Database;
  fetcher?: () => Promise<SteamNewsItem[]>;
  count?: number;
}

/**
 * The one-shot large-count backfill: fetch the ENTIRE appid-730 history in a
 * single guarded call and upsert every real patch note. Distinct from the
 * small-count incremental `pollUpdates` path (which the incremental cursor
 * owns) — this path always requests far more than the corpus holds so the fetch
 * guard proves nothing was truncated.
 *
 * Count reconciliation is a warning, never a hard fail: Valve's cadence drifts,
 * so an accepted count outside the expected band is surfaced loudly but does not
 * abort.
 *
 * @returns the number of accepted (upserted) notes.
 */
export async function runBackfill(opts: BackfillOptions = {}): Promise<number> {
  const db = opts.db ?? openDb();
  const count = opts.count ?? BACKFILL_COUNT;
  const fetcher = opts.fetcher ?? (() => fetchNewsItems(count));
  const items = await fetcher();
  const accepted = upsertUpdates(db, items);

  console.log(`backfill: upserted ${accepted} patch note(s) from ${items.length} feed item(s)`);
  if (accepted < RECONCILE_MIN || accepted > RECONCILE_MAX) {
    console.warn(
      `backfill: accepted count ${accepted} is outside the expected ` +
        `${RECONCILE_MIN}-${RECONCILE_MAX} band — review for filter drift.`,
    );
  }
  return accepted;
}
