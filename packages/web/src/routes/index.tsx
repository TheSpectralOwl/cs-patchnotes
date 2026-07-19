import { useState } from "react";
import type { SearchHit } from "../api";
import { useSearch } from "../hooks/useSearch";

/** Format a unix-epoch (seconds) post date for the Label meta row. */
function formatDate(postedAt: number): string {
  return new Date(postedAt * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** One result row: line text (Body) + parent title (Heading) + date & CS2 badge (Label). */
function ResultRow({ hit }: { hit: SearchHit }) {
  const gameLabel = hit.game === "cs2" ? "CS2" : "CS:GO";
  return (
    <li className="result-row">
      <h2 className="result-title">{hit.title}</h2>
      {/* Plain escaped React text — never dangerouslySetInnerHTML on note bodies. */}
      <p className="result-text">{hit.text}</p>
      <div className="result-meta">
        <span className="result-date">{formatDate(hit.posted_at)}</span>
        <span className="game-badge">{gameLabel}</span>
      </div>
    </li>
  );
}

function ResultList({ hits }: { hits: SearchHit[] }) {
  return (
    <ul className="result-list">
      {hits.map((hit) => (
        <ResultRow key={hit.id} hit={hit} />
      ))}
    </ul>
  );
}

const MagnifierIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export function IndexPage() {
  const [query, setQuery] = useState("");
  const { data, isError, isPending, isFetching, refetch } = useSearch(query);

  const hits = data?.hits ?? [];
  const isEmptyQuery = query.trim() === "";

  return (
    <>
      <header className="site-header">
        <h1 className="wordmark">CS Patch Notes</h1>
      </header>

      <div className="search-field">
        <MagnifierIcon />
        <input
          className="search-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search CS2 patch notes"
          aria-label="Search CS2 patch notes"
          autoFocus
        />
      </div>

      {isError ? (
        <div className="state-panel">
          <h2 className="state-heading">Search is unavailable</h2>
          <p className="state-body">
            We couldn&apos;t reach the search service. Check your connection and
            try again.
          </p>
          <button
            type="button"
            className="retry-button"
            onClick={() => refetch()}
          >
            Try again
          </button>
        </div>
      ) : isPending ? (
        <p className="loading-label">Searching…</p>
      ) : isEmptyQuery ? (
        <>
          <div className="state-panel">
            <h2 className="state-heading">Recent CS2 updates</h2>
            <p className="state-body">
              Start typing to search every line of recent Counter-Strike 2 patch
              notes.
            </p>
          </div>
          <ResultList hits={hits} />
        </>
      ) : hits.length === 0 && !isFetching ? (
        <div className="state-panel">
          <h2 className="state-heading">No matching lines</h2>
          <p className="state-body">
            Nothing matches &ldquo;{query}&rdquo;. Try a weapon, map, or keyword
            — like &ldquo;AWP&rdquo;, &ldquo;Dust II&rdquo;, or &ldquo;tick&rdquo;.
          </p>
        </div>
      ) : (
        <>
          <p className="result-count">
            {isFetching
              ? "Searching…"
              : `${hits.length} result${hits.length === 1 ? "" : "s"}`}
          </p>
          <ResultList hits={hits} />
        </>
      )}
    </>
  );
}
