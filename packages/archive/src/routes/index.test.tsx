import { describe, expect, it } from "vitest";
import {
  NoteBodyCache,
  archiveSearchParams,
  createSearchState,
  resetArchiveSearch,
  searchStateReducer,
  validateArchiveSearch,
} from "./search-state";

type Hit = { id: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("search state", () => {
  it("retains the latest successful hits while an update is pending or unavailable", () => {
    const loaded = searchStateReducer<Hit>(
      searchStateReducer(createSearchState<Hit>(), { type: "success", requestId: 1, hits: [{ id: "first" }] }),
      { type: "request", requestId: 2 },
    );
    const unavailable = searchStateReducer(loaded, { type: "failure", requestId: 2, error: "Search is unavailable" });

    expect(loaded).toMatchObject({ requestId: 2, hits: [{ id: "first" }], status: "updating" });
    expect(unavailable).toMatchObject({ requestId: 2, hits: [{ id: "first" }], status: "unavailable", error: "Search is unavailable" });
  });

  it("distinguishes initial loading from an empty successful search and ignores late responses", () => {
    const initial = createSearchState<Hit>();
    const latestRequest = searchStateReducer(initial, { type: "request", requestId: 2 });
    const staleSuccess = searchStateReducer(latestRequest, { type: "success", requestId: 1, hits: [{ id: "stale" }] });
    const empty = searchStateReducer(staleSuccess, { type: "success", requestId: 2, hits: [] });

    expect(initial.status).toBe("loading");
    expect(staleSuccess).toEqual(latestRequest);
    expect(empty).toMatchObject({ requestId: 2, hits: [], status: "empty", error: "" });
  });
});

describe("bounded note body cache", () => {
  it("shares one pending request per ID between prefetch and expansion", () => {
    const request = deferred<{ body: string }>();
    let calls = 0;
    const cache = new NoteBodyCache((id) => {
      calls += 1;
      expect(id).toBe("one");
      return request.promise;
    });

    cache.prefetch(["one"]);
    const expanded = cache.ensure("one");

    expect(calls).toBe(1);
    expect(expanded).toBe(cache.ensure("one"));
    expect(cache.record("one")).toMatchObject({ status: "pending" });
  });

  it("limits body prefetches to four active requests and removes obsolete queued IDs", () => {
    const requests = new Map<string, ReturnType<typeof deferred<{ body: string }>>>();
    const cache = new NoteBodyCache((id) => {
      const request = deferred<{ body: string }>();
      requests.set(id, request);
      return request.promise;
    });

    cache.prefetch(["one", "two", "three", "four", "obsolete"]);

    expect([...requests]).toHaveLength(4);
    expect(cache.queuedIds()).toEqual(["obsolete"]);

    cache.retain(["one", "two", "three", "four"]);

    expect(cache.queuedIds()).toEqual([]);
    expect(cache.record("obsolete")).toBeUndefined();
  });

  it("only replaces a failed body request after an explicit retry", async () => {
    const first = deferred<{ body: string }>();
    const second = deferred<{ body: string }>();
    let calls = 0;
    const cache = new NoteBodyCache(() => (calls++ === 0 ? first.promise : second.promise));

    const initial = cache.ensure("one");
    first.reject(new Error("Unavailable"));
    await expect(initial).rejects.toThrow("Unavailable");

    expect(cache.record("one")).toMatchObject({ status: "error" });
    expect(cache.ensure("one")).toBe(initial);
    expect(calls).toBe(1);

    const retried = cache.retry("one");
    second.resolve({ body: "Recovered" });

    await expect(retried).resolves.toEqual({ body: "Recovered" });
    expect(calls).toBe(2);
    expect(cache.record("one")).toMatchObject({ status: "ready", value: { body: "Recovered" } });
  });
});

describe("archive URL state", () => {
  it("preserves valid represented values and normalizes invalid games", () => {
    const search = validateArchiveSearch({ q: "smoke", game: "cs2", from: "2023-09-27", to: "2024-01-01" });

    expect(search).toEqual({ q: "smoke", game: "cs2", from: "2023-09-27", to: "2024-01-01" });
    expect(validateArchiveSearch({ game: "source2" })).toEqual({ q: "", game: "", from: "", to: "" });
    expect(archiveSearchParams(search).toString()).toBe("q=smoke&game=cs2&from=2023-09-27&to=2024-01-01");
  });

  it("clears every represented field for the single reset action", () => {
    expect(resetArchiveSearch()).toEqual({ q: "", game: "", from: "", to: "" });
  });
});
