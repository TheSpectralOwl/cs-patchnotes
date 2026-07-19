import type { Database } from "better-sqlite3";
import { openDb } from "@cs-patchnotes/shared";

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
 * The two-stage feed filter (the load-bearing discriminator).
 *
 * Stage 1 — source: drop anything that is not a Valve community announcement.
 * Stage 2 — content: accept only titles matching the CS2 update pattern.
 *
 * Live data proves marketing posts carry `feed_type: 1`,
 * `feedname: "steam_community_announcements"`, AND the `patchnotes` tag — so the
 * `tags` array and `feedname` are NOT trustworthy on their own. The anchored
 * title match is the correct discriminator.
 */
export function isCs2PatchNote(item: SteamNewsItem): boolean {
  if (item.feed_type !== 1 || item.feedname !== "steam_community_announcements") {
    return false;
  }
  return /^Counter-Strike 2 Update/.test(item.title);
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
  const accepted = items.filter(isCs2PatchNote);
  const fetchedAt = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO updates (id, posted_at, title, url, feedname, game, raw_body, fetched_at)
    VALUES (@id, @posted_at, @title, @url, @feedname, @game, @raw_body, @fetched_at)
    ON CONFLICT(id) DO UPDATE SET
      posted_at  = excluded.posted_at,
      title      = excluded.title,
      url        = excluded.url,
      feedname   = excluded.feedname,
      game       = excluded.game,
      raw_body   = excluded.raw_body,
      fetched_at = excluded.fetched_at
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
      });
    }
  });

  tx(accepted);
  return accepted.length;
}

/**
 * Fetch the newest `count` news items for CS2 (appid 730) with full bodies.
 * `maxlength=0` returns untruncated `contents`. Native `fetch`, no dependency.
 */
async function fetchNewsItems(count: number): Promise<SteamNewsItem[]> {
  const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&maxlength=0&count=${count}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Steam News fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { appnews?: { newsitems?: SteamNewsItem[] } };
  return data.appnews?.newsitems ?? [];
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
