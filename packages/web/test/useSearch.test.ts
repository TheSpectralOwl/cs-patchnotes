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

  it("throws when the API responds with a non-ok status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSearch("awp", 20)).rejects.toThrow();
  });
});
