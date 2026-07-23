import { Link, createFileRoute } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { startTransition, useDeferredValue, useEffect, useState } from "react";

type Game = "csgo" | "cs2";
type Hit = { id: string; title: string; date: string; game: Game; source_url: string; matching_lines: string[]; more_changes: number };

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q : "",
    game: search.game === "csgo" || search.game === "cs2" ? search.game : "",
    from: typeof search.from === "string" ? search.from : "",
    to: typeof search.to === "string" ? search.to : "",
  }),
  component: Archive,
});

function Archive() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [query, setQuery] = useState(search.q);
  const [game, setGame] = useState(search.game);
  const [from, setFrom] = useState(search.from);
  const [to, setTo] = useState(search.to);
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const deferredQuery = useDeferredValue(query);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const parameters = new URLSearchParams();
    if (deferredQuery) parameters.set("q", deferredQuery);
    if (game) parameters.set("game", game);
    if (from) parameters.set("from", from);
    if (to) parameters.set("to", to);
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/search?${parameters}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Search is currently unavailable.");
        return response.json() as Promise<{ hits: Hit[] }>;
      })
      .then(({ hits: nextHits }) => { setHits(nextHits); setError(""); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Search is currently unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [deferredQuery, game, from, to]);

  function update(next: Partial<typeof search>) {
    startTransition(() => navigate({ search: { q: query, game, from, to, ...next }, replace: true }));
  }

  return <main className="archive-shell">
    <motion.header className="masthead" initial={reduceMotion ? false : { y: -10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.38, ease: "easeOut" }}><Link to="/" className="wordmark">CS <span>PATCH NOTES</span></Link><span className="masthead-status">Official archive</span></motion.header>
    <motion.section className="search-intro" initial={reduceMotion ? false : { y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.48, delay: 0.08, ease: "easeOut" }}>
      <p className="eyebrow">Counter-Strike / changelog</p>
      <h1>History, at the<br /><em>moment it changed.</em></h1>
      <div className="search-line"><label><span className="sr-only">Search patch notes</span><input value={query} onChange={(event) => { setQuery(event.target.value); update({ q: event.target.value }); }} placeholder="Search a map, weapon, or system" autoFocus /></label><span className="result-count">{loading ? "Searching" : `${hits.length} notes`}</span></div>
      <div className="filter-bar" aria-label="Archive filters">
        <label><span>Game</span><select value={game} onChange={(event) => { setGame(event.target.value as Game | ""); update({ game: event.target.value as Game | "" }); }}><option value="">All eras</option><option value="csgo">CS:GO</option><option value="cs2">CS2</option></select></label>
        <label><span>From</span><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); update({ from: event.target.value }); }} /></label>
        <label><span>To</span><input type="date" value={to} onChange={(event) => { setTo(event.target.value); update({ to: event.target.value }); }} /></label>
        {(query || game || from || to) && <button className="clear-filters" onClick={() => { setQuery(""); setGame(""); setFrom(""); setTo(""); update({ q: "", game: "", from: "", to: "" }); }}>Clear filters</button>}
      </div>
    </motion.section>
    {error ? <p className="state error">{error}</p> : <section className="timeline" aria-live="polite">
      <div className="spine" />
      <AnimatePresence initial={false}>{hits.map((hit) => <TimelineEntry key={hit.id} hit={hit} expanded={expanded.has(hit.id)} reduceMotion={reduceMotion} onToggle={() => setExpanded((current) => { const next = new Set(current); next.has(hit.id) ? next.delete(hit.id) : next.add(hit.id); return next; })} />)}</AnimatePresence>
      {!loading && hits.length === 0 && <p className="state">No notes match those filters.</p>}
    </section>}
  </main>;
}

function TimelineEntry({ hit, expanded, reduceMotion, onToggle }: { hit: Hit; expanded: boolean; reduceMotion: boolean | null; onToggle(): void }) {
  const shownLines = expanded ? hit.matching_lines : hit.matching_lines.slice(0, 3);
  return <motion.article className="timeline-entry" layout initial={reduceMotion ? false : { y: 12 }} animate={{ y: 0 }} exit={reduceMotion ? undefined : { y: -8 }} transition={{ duration: 0.26, ease: "easeOut" }}>
    <div className="date-gutter"><time dateTime={hit.date}>{hit.date}</time><span>{hit.game === "cs2" ? "CS2" : "CS:GO"}</span></div>
    <div className="node" />
    <div className="entry-content"><Link to="/notes/$id" params={{ id: hit.id }} className="note-title">{hit.title}</Link><p className="kind"><i />Official patch notes</p>
      <motion.ul layout="position">{shownLines.map((line, index) => <motion.li layout key={`${line}-${index}`} initial={reduceMotion ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>{line.replace(/^\s*-\s+/, "")}</motion.li>)}</motion.ul>
      {hit.more_changes > 0 && <button className="more" onClick={onToggle} aria-expanded={expanded}>{expanded ? "Show fewer changes" : `+ ${hit.more_changes} more changes`}</button>}
    </div>
  </motion.article>;
}
