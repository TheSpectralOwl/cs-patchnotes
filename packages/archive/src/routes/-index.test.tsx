import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { contextualHits, TimelineEntry, timelineTransition } from "./index";
import {
  type ArchiveSearch,
  NoteBodyCache,
  archiveSearchParams,
  createSearchState,
  resetArchiveSearch,
  searchStateReducer,
  validateArchiveSearch,
} from "./-search-state";

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
  it("rejects legacy API hits that lack contextual sections", () => {
    expect(() => contextualHits({ hits: [{ id: "legacy", matching_lines: ["old preview"] }] })).toThrow(
      "Search results require the updated archive API. Deploy the API, then retry.",
    );
  });

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

describe("contextual timeline entries", () => {
  const search: ArchiveSearch = { q: "Smoke", game: "cs2", from: "2023-09-27", to: "" };
  const hit = {
    id: "note-one",
    title: "Smoke Update",
    date: "2024-01-01",
    game: "cs2" as const,
    source_url: "https://example.test/source",
    sections: [
      {
        heading: "*smoke* heading",
        items: [
          { markdown: "**smoke** change", kind: "change" as const, matched: true },
          { markdown: "[smoke](https://example.test)", kind: "prose" as const, matched: false },
        ],
      },
      {
        heading: "Second section",
        items: [{ markdown: "Adjacent sibling", kind: "change" as const, matched: false }],
      },
    ],
  };

  it("renders every ordered contextual section with nested literal marks and safe note navigation", async () => {
    const cache = new NoteBodyCache(async () => ({ body: "# Smoke Update\n\nComplete *smoke* patch." }));
    await cache.ensure(hit.id);

    const rootRoute = createRootRoute();
    const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: "notes/$id", component: () => null });
    const entryRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <TimelineEntry hit={hit} search={search} previewTokens={["smoke"]} cache={cache} expanded reduceMotion={false} onRefresh={() => undefined} onToggle={() => undefined} />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([entryRoute, noteRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toMatch(/smoke.*heading[\s\S]*smoke.*change[\s\S]*smoke[\s\S]*Second section[\s\S]*Adjacent sibling/);
    expect(markup).toContain("<em><mark>smoke</mark></em>");
    expect(markup).toContain("<strong><mark>smoke</mark></strong>");
    expect(markup).toContain('<a class="note-link" href="https://example.test/" target="_blank" rel="noopener noreferrer"><mark>smoke</mark></a>');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="patch-note-one"');
    expect(markup).toContain('id="patch-note-one"');
    expect(markup).toContain('href="/notes/note-one?q=Smoke&amp;game=cs2&amp;from=2023-09-27&amp;to="');
    expect(markup).toContain("Complete <em>smoke</em> patch.");
  });

  it("uses an immediate layout transition when reduced motion is requested", () => {
    expect(timelineTransition(true)).toEqual({ duration: 0 });
    expect(timelineTransition(false)).toEqual({ duration: 0.26, ease: "easeOut" });
  });
});
