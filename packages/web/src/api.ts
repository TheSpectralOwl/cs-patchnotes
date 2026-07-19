// Typed client for the proxy `/search` endpoint. The SPA talks ONLY to the API
// (`VITE_API_URL` carries the public API base — never a Meili key or host); the
// browser must never import the Meilisearch SDK. `VITE_API_URL` is a Vite env
// var (build-time inlined), distinct from the Node `.env.example` secret set.

/** One search hit / recent-updates line as returned by the API. */
export interface SearchHit {
  id: string;
  update_id: string;
  text: string;
  title: string;
  posted_at: number;
  game: "cs2" | "csgo";
  url: string;
  section: string;
}

/** The `/search` response shape (Meilisearch-style `hits` envelope). */
export interface SearchResponse {
  hits: SearchHit[];
  estimatedTotalHits?: number;
  query?: string;
}

const API_BASE = import.meta.env.VITE_API_URL ?? "";

/**
 * GET `${VITE_API_URL}/search?q=<encoded>&limit=<n>`. An empty query is valid —
 * the API returns the newest-first recent-updates landing, so the SPA never
 * shows a blank screen. Throws on a non-ok response so callers can render the
 * error state.
 */
export async function fetchSearch(q: string, limit = 20): Promise<SearchResponse> {
  const url = `${API_BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Search request failed: ${res.status}`);
  }
  return (await res.json()) as SearchResponse;
}
