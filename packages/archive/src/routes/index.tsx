import { Link, createFileRoute } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { startTransition, useDeferredValue, useEffect, useReducer, useRef, useState } from "react";
import { NoteMarkdown, PreviewMarkdown, normalizePreviewQueryTokens } from "../components/note-markdown";
import {
  NoteBodyCache,
  archiveSearchParams,
  createSearchState,
  resetArchiveSearch,
  searchStateReducer,
  validateArchiveSearch,
  type ArchiveSearch,
} from "./search-state";

type PreviewItem = { markdown: string; kind: "change" | "prose" | "heading"; matched: boolean };
type Hit = {
  id: string;
  title: string;
  date: string;
  game: Exclude<ArchiveSearch["game"], "">;
  source_url: string;
  sections: Array<{ heading: string; items: PreviewItem[] }>;
};
type Note = { body: string };

export const Route = createFileRoute("/")({ validateSearch: validateArchiveSearch, component: Archive });

function Archive() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(search.q);
  const [game, setGame] = useState(search.game);
  const [from, setFrom] = useState(search.from);
  const [to, setTo] = useState(search.to);
  const [results, dispatchResults] = useReducer(searchStateReducer<Hit>, createSearchState<Hit>());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [retryNonce, setRetryNonce] = useState(0);
  const [, setCacheVersion] = useState(0);
  const requestId = useRef(0);
  const cache = useState(() => new NoteBodyCache<Note>(async (id, signal) => {
    const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, { signal });
    if (!response.ok) throw new Error("The full patch could not be loaded.");
    return response.json() as Promise<Note>;
  }, 4, () => setCacheVersion((version) => version + 1)))[0];
  const deferredQuery = useDeferredValue(query);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const controller = new AbortController();
    const currentRequest = ++requestId.current;
    dispatchResults({ type: "request", requestId: currentRequest });
    fetch(`/api/search?${archiveSearchParams({ q: deferredQuery, game, from, to })}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Search is unavailable");
        return response.json() as Promise<{ hits: Hit[] }>;
      })
      .then(({ hits }) => {
        if (controller.signal.aborted) return;
        cache.retain(hits.map((hit) => hit.id));
        cache.prefetch(hits.map((hit) => hit.id));
        dispatchResults({ type: "success", requestId: currentRequest, hits });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) dispatchResults({ type: "failure", requestId: currentRequest, error: reason instanceof Error ? reason.message : "Search is unavailable" });
      });
    return () => controller.abort();
  }, [cache, deferredQuery, from, game, retryNonce, to]);

  function update(next: Partial<ArchiveSearch>) {
    startTransition(() => navigate({ search: { q: query, game, from, to, ...next }, replace: true }));
  }

  function applyFilters(next: Partial<ArchiveSearch>) {
    setGame(next.game ?? game);
    setFrom(next.from ?? from);
    setTo(next.to ?? to);
    update(next);
  }

  function reset() {
    const cleared = resetArchiveSearch();
    setQuery(cleared.q);
    applyFilters(cleared);
  }

  return <main className="archive-shell">
    <motion.header className="masthead" initial={reduceMotion ? false : { y: -10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.38, ease: "easeOut" }}><Link to="/" className="wordmark">CS <span>PATCH NOTES</span></Link><span className="masthead-status">Official archive</span></motion.header>
    <motion.section className="search-panel" initial={reduceMotion ? false : { y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.38, delay: 0.08, ease: "easeOut" }}>
      <div className="search-line"><label><span className="sr-only">Search patch notes</span><input value={query} onChange={(event) => { setQuery(event.target.value); update({ q: event.target.value }); }} placeholder="Search a map, weapon, or system" autoFocus /></label><span className="result-count">{results.status === "loading" ? "Loading archive…" : results.status === "updating" ? "Updating results…" : `${results.hits.length} notes`}</span></div>
      <div className="filter-bar" aria-label="Archive filters">
        <div className="filter-group"><span>Game</span><div className="filter-options"><button className={!game ? "active" : ""} onClick={() => applyFilters({ game: "" })}>All games</button><button className={game === "csgo" ? "active" : ""} onClick={() => applyFilters({ game: "csgo" })}>CS:GO</button><button className={game === "cs2" ? "active" : ""} onClick={() => applyFilters({ game: "cs2" })}>CS2</button></div></div>
        <div className="filter-group"><span>Era</span><div className="filter-options"><button className={!from && !to ? "active" : ""} onClick={() => applyFilters({ from: "", to: "" })}>All time</button><button className={from === "2012-01-01" && to === "2023-09-26" ? "active" : ""} onClick={() => applyFilters({ from: "2012-01-01", to: "2023-09-26" })}>CS:GO era</button><button className={from === "2023-09-27" && !to ? "active" : ""} onClick={() => applyFilters({ from: "2023-09-27", to: "" })}>CS2 era</button></div></div>
        {(query || game || from || to) && <button className="clear-filters" onClick={reset}>Reset search</button>}
      </div>
    </motion.section>
    <section className="timeline" aria-live="polite" aria-busy={results.status === "loading" || results.status === "updating"}>
      <div className="spine" />
      <p className="sr-only" role="status">{results.status === "updating" ? "Updating results…" : results.status === "unavailable" && results.hits.length > 0 ? "Unable to update results. Showing the previous result set." : ""}</p>
      <AnimatePresence initial={false}>{results.hits.map((hit) => <TimelineEntry key={hit.id} hit={hit} search={search} cache={cache} expanded={expanded.has(hit.id)} reduceMotion={reduceMotion} onRefresh={() => setCacheVersion((version) => version + 1)} onToggle={() => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(hit.id)) next.delete(hit.id);
        else {
          next.add(hit.id);
          void cache.ensure(hit.id).finally(() => setCacheVersion((version) => version + 1));
        }
        return next;
      })} />)}</AnimatePresence>
      {results.status === "unavailable" && <p className="state error">{results.hits.length > 0 ? "Unable to update results. Showing the previous result set." : "Search is unavailable"} <button className="more" onClick={() => setRetryNonce((value) => value + 1)}>Retry search</button></p>}
      {results.status === "empty" && <div className="state"><h2>No matching patch notes</h2><p>Nothing in this archive matches your current search or filters. Try another term or reset the search.</p><button className="more" onClick={reset}>Reset search</button></div>}
    </section>
  </main>;
}

function TimelineEntry({ hit, search, cache, expanded, reduceMotion, onRefresh, onToggle }: { hit: Hit; search: ArchiveSearch; cache: NoteBodyCache<Note>; expanded: boolean; reduceMotion: boolean | null; onRefresh(): void; onToggle(): void }) {
  const record = cache.record(hit.id);
  const queryTokens = normalizePreviewQueryTokens(search.q);
  const expandedRegionId = `patch-${hit.id}`;
  return <motion.article className="timeline-entry" layout initial={reduceMotion ? false : { y: 12 }} animate={{ y: 0 }} exit={reduceMotion ? undefined : { y: -8 }} transition={{ duration: 0.26, ease: "easeOut" }}>
    <div className="date-gutter"><time dateTime={hit.date}>{hit.date}</time><span>{hit.game === "cs2" ? "CS2" : "CS:GO"}</span></div><div className="node" />
    <div className="entry-content"><Link to="/notes/$id" params={{ id: hit.id }} search={search} className="note-title">{hit.title}</Link><p className="kind"><i />Official patch notes</p>
      {hit.sections.map((section, sectionIndex) => <section key={`${section.heading}-${sectionIndex}`} className="context-section"><p className="context-heading"><PreviewMarkdown markdown={section.heading} queryTokens={queryTokens} /></p>{section.items.map((item, itemIndex) => <p key={`${item.markdown}-${itemIndex}`} className={item.kind === "change" ? "preview-change" : "preview-prose"}><PreviewMarkdown markdown={item.markdown} queryTokens={queryTokens} /></p>)}</section>)}
      {record?.status === "error" ? <><p className="state error">The full patch could not be loaded. Retry to load it.</p><button className="more" onClick={() => { void cache.retry(hit.id).finally(onRefresh); }}>Retry full patch</button></> : <button className="more" onClick={onToggle} aria-expanded={expanded} aria-controls={expandedRegionId}>{expanded ? "Collapse patch" : record?.status === "pending" ? "Loading full patch…" : "Show full patch"}</button>}
      {expanded && record?.status === "ready" && record.value && <motion.div id={expandedRegionId} className="note-body" layout="position"><NoteMarkdown body={record.value.body} title={hit.title} /></motion.div>}
    </div>
  </motion.article>;
}
