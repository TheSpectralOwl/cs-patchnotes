import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NoteMarkdown, SourceAction } from "../../components/note-markdown";

type Note = { title: string; date: string; game: string; source_url: string; body: string };

export const Route = createFileRoute("/notes/$id")({ component: NotePage });

function NotePage() {
  const { id } = Route.useParams();
  const [note, setNote] = useState<Note>();
  const [error, setError] = useState("");
  useEffect(() => { fetch(`/api/notes/${encodeURIComponent(id)}`).then(async (response) => {
    if (!response.ok) throw new Error("This note is unavailable.");
    return response.json() as Promise<Note>;
  }).then(setNote).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "This note is unavailable.")); }, [id]);
  if (error) return <main className="archive-shell"><p className="state error">{error}</p></main>;
  if (!note) return <main className="archive-shell"><p className="state">Loading note...</p></main>;
  return <main className="archive-shell note-page"><header className="masthead"><Link to="/" className="wordmark">CS PATCH NOTES</Link><Link to="/">BACK TO ARCHIVE</Link></header><article>
    <p className="eyebrow">{note.date} / {note.game === "cs2" ? "COUNTER-STRIKE 2" : "COUNTER-STRIKE: GLOBAL OFFENSIVE"}</p><h1>{note.title}</h1><SourceAction href={note.source_url} />
    <div className="note-body"><NoteMarkdown body={note.body} title={note.title} /></div>
  </article></main>;
}
