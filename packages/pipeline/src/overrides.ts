import type { Channel } from "@cs-patchnotes/shared";

/**
 * The committed, human-auditable override list keyed by Steam gid.
 *
 * The two-stage title filter admits the overwhelming majority of real patch
 * notes automatically. A handful of genuine Valve patch notes ship under a
 * marketing-style headline that no title pattern matches — these are admitted
 * here, one gid at a time, only after a human has read the post and confirmed it
 * carries real change notes. Each entry records durable provenance (the post's
 * human-readable title and date) so a future reviewer can re-audit the decision
 * without access to the live feed.
 *
 * This module is authored as a typed constant rather than a loose JSON asset so
 * `tsc` keeps it in `dist/` (a bare `.json` sidecar would be dropped from the
 * build output).
 */
export interface AllowEntry {
  /** Release channel this post is filed under. */
  channel: Channel;
  /** Human-readable post title, recorded for re-audit. */
  title: string;
  /** Post date (YYYY-MM-DD), recorded for re-audit. */
  date: string;
  /** Optional provenance note (e.g. a known duplicate gid). */
  note?: string;
}

/**
 * Off-title real patch notes admitted after manual feed review, keyed by gid.
 *
 * Each of these posts documents real gameplay/matchmaking/store changes players
 * search for, but carries a headline the title patterns do not match. They were
 * each read and confirmed by hand before being added here.
 */
export const ALLOW_LIST: Record<string, AllowEntry> = {
  "4026755437314208134": {
    channel: "mainline",
    title: "Premier for All",
    date: "2021-03-29",
    note: "Off-title real patch note (matchmaking change), admitted after manual feed review.",
  },
  "4093189347044611120": {
    channel: "mainline",
    title: "Adjustments to Non-Prime",
    date: "2021-06-04",
    note: "Off-title real patch note (gameplay/matchmaking changes), admitted after manual feed review.",
  },
  "1813041031352604": {
    channel: "beta",
    title: "Counter-Strike 2 Pre-Release Update",
    date: "2025-10-13",
    note: "Off-title real patch note on the pre-release (beta) channel, admitted after manual feed review.",
  },
  "3879252510628624545": {
    channel: "mainline",
    title: "Week 2 Missions and More",
    date: "2020-12-09",
    note: "Off-title real patch note bundling two dated release notes (misc + 15 map changes), admitted after manual feed review.",
  },
  "4090922416496931545": {
    channel: "mainline",
    title: "2021 Can't Come Soon Enough",
    date: "2020-12-18",
    note: "Off-title real patch note carrying the Operation Broken Fang + misc changelog, admitted after manual feed review.",
  },
  "4048146376711756574": {
    channel: "store",
    title: "3 New Music Kits and a Poorly Drawn Sticker Capsule",
    date: "2021-03-19",
    note: "Store-only post that is the sole source of that day's release notes; admitted after manual feed review so the notes are not lost.",
  },
  "1010228711585010877": {
    channel: "mainline",
    title: "CS:GO - The Winter Offensive Update",
    date: "2013-12-19",
    note: "Mainline major update. This post exists twice in the feed under two gids; the twin gid 3819571008275480883 is the known duplicate and is intentionally NOT admitted (it is off-title so the filter drops it automatically), which keeps this post from surfacing twice and keeps the deny-list empty.",
  },
};

/**
 * The human-audited kill-switch. A gid listed here is rejected even if its title
 * matches a patch-note pattern.
 *
 * It starts empty: every clean title match reviewed so far is a genuine patch
 * note, so there are no false positives to suppress. It exists as the explicit
 * override lever for the day a title-matched post turns out not to be a real
 * patch note.
 */
export const DENY_LIST: ReadonlySet<string> = new Set<string>();
