// Typed client for the proxy `/search` endpoint. The SPA talks ONLY to the API
// (`VITE_API_URL` carries the public API base — never a Meili key or host); the
// browser must never import the Meilisearch SDK. `VITE_API_URL` is a Vite env
// var (build-time inlined), distinct from the Node `.env.example` secret set.

/** One search hit / recent-updates line as returned by the API. */
export interface SearchHit {
  id: string;
  text: string;
  title: string;
  posted_at: number;
  game: "cs2" | "csgo";
}

export interface SearchTruncation {
  truncated: boolean;
  request_count: number;
  hydrated_count: number;
  dropped_count: number;
}

/** Display-ready search response consumed by the SPA. */
export interface SearchResponse {
  hits: SearchHit[];
  truncation?: SearchTruncation;
}

interface CanonicalSearchHit {
  kind: "direct" | "subgroup" | "document";
  document_id: string;
  fragment_id: string | null;
  block_id: string | null;
  group_anchor_block_id?: string | null;
  representative_text: string;
  context: {
    document: {
      title: string;
      posted_at: number;
      game: "cs2" | "csgo";
    };
  };
}

interface CanonicalSearchResponse {
  hits: CanonicalSearchHit[];
  truncation?: SearchTruncation;
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
  const response = (await res.json()) as CanonicalSearchResponse;
  const hits = response.hits.map((hit) => ({
    id: `${hit.kind}:${hit.document_id}:${hit.fragment_id ?? hit.group_anchor_block_id ?? hit.block_id ?? hit.document_id}`,
    text: hit.representative_text,
    title: hit.context.document.title,
    posted_at: hit.context.document.posted_at,
    game: hit.context.document.game,
  }));

  return response.truncation ? { hits, truncation: response.truncation } : { hits };
}
