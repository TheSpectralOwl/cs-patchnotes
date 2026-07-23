import { startTransition, useDeferredValue, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Game = "csgo" | "cs2";
type Note = { id: string; title: string; date: string; game: Game; steam_gid: string; source_url: string; body: string };
type Index = { documents: Note[]; terms: Record<string, Array<[number, number]>> };

function tokens(value: string) {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

function readLocation() {
  const url = new URL(window.location.href);
  const noteId = url.pathname.startsWith("/notes/") ? decodeURIComponent(url.pathname.slice("/notes/".length)) : null;
  return { noteId, query: url.searchParams.get("q") ?? "", game: url.searchParams.get("game") as Game | "" | null };
}

function makeUrl(noteId: string | null, query: string, game: string) {
  const parameters = new URLSearchParams();
  if (query) parameters.set("q", query);
  if (game) parameters.set("game", game);
  const path = noteId ? `/notes/${encodeURIComponent(noteId)}` : "/";
  return `${path}${parameters.size ? `?${parameters}` : ""}`;
}

function search(index: Index, query: string, game: string) {
  const queryTokens = tokens(query);
  const scores = new Map<number, number>();
  if (queryTokens.length === 0) index.documents.forEach((_, id) => scores.set(id, 0));
  for (const token of queryTokens) {
    for (const [id, count] of index.terms[token] ?? []) scores.set(id, (scores.get(id) ?? 0) + count);
  }
  return [...scores]
    .map(([id, score]) => ({ ...index.documents[id], score }))
    .filter((note) => !game || note.game === game)
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function inline(value: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\((https?:\/\/[^)]+)\)|<(https?:\/\/[^>]+)>)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    nodes.push(value.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("**")) nodes.push(<strong key={cursor}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("*")) nodes.push(<em key={cursor}>{token.slice(1, -1)}</em>);
    else nodes.push(<a key={cursor} href={match[3] ?? match[4]} target="_blank" rel="noreferrer">{match[2] ?? match[4]}</a>);
    cursor = (match.index ?? 0) + token.length;
  }
  nodes.push(value.slice(cursor));
  return nodes;
}

function NoteBody({ note }: { note: Note }) {
  return <div className="note-body">{note.body.split("\n").map((line, index) => {
    if (!line || line === `# ${note.title}`) return null;
    const heading = line.match(/^(#{2,3})\s+(.+)$/);
    const bullet = line.match(/^(\s*)-\s+(.+)$/);
    if (heading) {
      const Tag = heading[1].length === 2 ? "h2" : "h3";
      return <Tag key={index}>{inline(heading[2])}</Tag>;
    }
    if (bullet) return <p className="bullet" style={{ "--depth": Math.floor(bullet[1].length / 2) } as CSSProperties} key={index}>{inline(bullet[2])}</p>;
    return <p key={index}>{inline(line)}</p>;
  })}</div>;
}

function App() {
  const [index, setIndex] = useState<Index>();
  const [error, setError] = useState<string>();
  const [location, setLocation] = useState(readLocation);
  const [query, setQuery] = useState(location.query);
  const [game, setGame] = useState(location.game === "csgo" || location.game === "cs2" ? location.game : "");
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}notes-index.json`).then((response) => {
      if (!response.ok) throw new Error("The archive index could not be loaded.");
      return response.json() as Promise<Index>;
    }).then(setIndex).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "The archive is unavailable."));
  }, []);
  useEffect(() => {
    const onPopState = () => { const next = readLocation(); setLocation(next); setQuery(next.query); setGame(next.game === "csgo" || next.game === "cs2" ? next.game : ""); };
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);

  function navigate(noteId: string | null, nextQuery = query, nextGame = game, replace = false) {
    const url = makeUrl(noteId, nextQuery.trim(), nextGame);
    history[replace ? "replaceState" : "pushState"](null, "", url);
    setLocation({ noteId, query: nextQuery.trim(), game: nextGame as Game | "" });
  }
  const results = index ? search(index, deferredQuery, game) : [];
  const selected = index?.documents.find((note) => note.id === location.noteId) ?? results[0];

  return <>
    <header className="topbar"><button className="wordmark" onClick={() => navigate(null)}>CS <span>PATCH NOTES</span></button><p>OFFICIAL CHANGELOG ARCHIVE</p></header>
    <main>
      <section className="hero"><p className="kicker">2003—NOW / COUNTER-STRIKE</p><h1>Every change has<br /><em>a before and after.</em></h1><p className="intro">Search official patch notes, then read the whole update in its original context.</p></section>
      <section className="toolbox" aria-label="Search archive">
        <input aria-label="Search patch notes" value={query} onChange={(event) => startTransition(() => { setQuery(event.target.value); navigate(location.noteId, event.target.value, game, true); })} placeholder="Search weapons, maps, systems..." />
        <select aria-label="Filter by game" value={game} onChange={(event) => startTransition(() => { setGame(event.target.value); navigate(location.noteId, query, event.target.value, true); })}><option value="">All eras</option><option value="cs2">Counter-Strike 2</option><option value="csgo">CS:GO</option></select>
      </section>
      {error ? <p className="error">{error}</p> : !index ? <p className="loading">Loading {"//"} 275 official notes</p> : <section className="archive-layout">
        <aside className="result-list"><div className="list-heading"><span>{results.length} note{results.length === 1 ? "" : "s"}</span>{(query || game) && <button onClick={() => { setQuery(""); setGame(""); navigate(null, "", ""); }}>Reset</button>}</div>
          {results.map((note) => <button key={note.id} className={`result ${selected?.id === note.id ? "selected" : ""}`} onClick={() => navigate(note.id)}><span>{note.date} / {note.game === "cs2" ? "CS2" : "CS:GO"}</span><b>{note.title}</b><small>{note.body.replace(/\s+/g, " ").slice(0, 135)}...</small></button>)}
        </aside>
        <article className="note">{selected ? <><header><p className="kicker">{selected.date} / {selected.game === "cs2" ? "COUNTER-STRIKE 2" : "COUNTER-STRIKE: GLOBAL OFFENSIVE"}</p><h2>{selected.title}</h2><a href={selected.source_url} target="_blank" rel="noreferrer">Original Steam post ↗</a></header><NoteBody note={selected} /></> : <p className="empty">No note matches those filters.</p>}</article>
      </section>}
    </main>
  </>;
}

const root = document.querySelector("#root");
if (!root) throw new Error("Missing app root");
createRoot(root).render(<App />);
