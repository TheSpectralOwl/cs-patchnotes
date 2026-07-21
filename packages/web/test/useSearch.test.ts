import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSearch } from "../src/api";
import { useDebounced } from "../src/hooks/useSearch";

describe("useDebounced", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles to the last value after the debounce interval, ignoring intermediate values", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 200), {
      initialProps: { v: "a" },
    });

    expect(result.current).toBe("a");

    // Rapid changes before the interval elapses — none should settle yet.
    rerender({ v: "ab" });
    rerender({ v: "abc" });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe("a");

    // After the full interval past the last change, it settles to the last value.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("abc");
  });
});

describe("fetchSearch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GETs the /search endpoint with an encoded query and limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchSearch("Dust II", 20);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/search?q=Dust%20II&limit=20");
  });

  it("maps canonical hydrated hits into display rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          hits: [
            {
              kind: "direct",
              document_id: "doc-1",
              fragment_id: "fragment-1",
              block_id: "block-1",
              representative_text: "Reduced AWP magazine size.",
              context: {
                document: {
                  id: "doc-1",
                  title: "Counter-Strike 2 Update",
                  posted_at: 1_769_036_288,
                  game: "cs2",
                },
              },
            },
          ],
          truncation: {
            truncated: false,
            request_count: 1,
            hydrated_count: 1,
            dropped_count: 0,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSearch("AWP", 20)).resolves.toEqual({
      hits: [
        {
          id: "direct:doc-1:fragment-1",
          text: "Reduced AWP magazine size.",
          title: "Counter-Strike 2 Update",
          posted_at: 1_769_036_288,
          game: "cs2",
        },
      ],
      truncation: {
        truncated: false,
        request_count: 1,
        hydrated_count: 1,
        dropped_count: 0,
      },
    });
  });

  it("throws when the API responds with a non-ok status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSearch("awp", 20)).rejects.toThrow();
  });
});
