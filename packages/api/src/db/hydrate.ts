import Database, { type Database as DatabaseType } from "better-sqlite3";
import {
  hydrateRankedFragments,
  type HydrationOptions,
  type HydrationResult,
  type RankedHydrationRequest,
} from "@cs-patchnotes/shared";

export interface SearchHydrator {
  hydrate(requests: readonly RankedHydrationRequest[]): HydrationResult;
  close(): void;
}

/** Own one lazy, read-only SQLite connection for the search route lifecycle. */
export function createSearchHydrator(options: HydrationOptions = {}): SearchHydrator {
  let db: DatabaseType | undefined;

  function getDb(): DatabaseType {
    if (db === undefined) {
      db = new Database(process.env.SQLITE_PATH ?? "./patchnotes.db", {
        readonly: true,
        fileMustExist: true,
      });
      db.pragma("query_only = ON");
    }
    return db;
  }

  return {
    hydrate: (requests) => hydrateRankedFragments(getDb(), requests, options),
    close: () => {
      if (db?.open) db.close();
      db = undefined;
    },
  };
}
