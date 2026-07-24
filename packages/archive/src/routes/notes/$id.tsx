import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { NoteMarkdown, SourceAction } from "../../components/note-markdown";
import { validateArchiveSearch } from "../-search-state";

export type Note = { title: string; date: string; game: string; source_url: string; body: string };

export type NoteViewState = {
  id: string;
  requestId: number;
  note?: Note;
  error: string;
};

export type NoteViewAction =
  | { type: "request"; id: string; requestId: number }
  | { type: "success"; id: string; requestId: number; note: Note }
  | { type: "failure"; id: string; requestId: number; error: string };

export function noteViewReducer(state: NoteViewState, action: NoteViewAction): NoteViewState {
  if (action.type === "request") return { id: action.id, requestId: action.requestId, error: "" };
  if (action.id !== state.id || action.requestId !== state.requestId) return state;
  return action.type === "success" ? { ...state, note: action.note } : { ...state, error: action.error };
}

export const Route = createFileRoute("/notes/$id")({ validateSearch: validateArchiveSearch, component: NotePage });

function NotePage() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const [view, dispatch] = useReducer(noteViewReducer, { id, requestId: 0, error: "" });
  const [retryNonce, setRetryNonce] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const currentRequest = ++requestId.current;
    dispatch({ type: "request", id, requestId: currentRequest });
    void fetch(`/api/notes/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("This note is unavailable.");
        return response.json() as Promise<Note>;
      })
      .then((note) => {
        if (!controller.signal.aborted) dispatch({ type: "success", id, requestId: currentRequest, note });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) dispatch({ type: "failure", id, requestId: currentRequest, error: reason instanceof Error ? reason.message : "This note is unavailable." });
      });
    return () => controller.abort();
  }, [id, retryNonce]);

  const back = <Link to="/" search={search}>Back to archive</Link>;
  if (view.id !== id || !view.note) {
    if (view.id === id && view.error) {
      return <main className="archive-shell"><header className="masthead"><Link to="/" className="wordmark">CS PATCH NOTES</Link>{back}</header><section className="state error" role="status"><h1>This note is unavailable</h1><p>The patch could not be loaded. Retry or return to the archive.</p><button className="more" onClick={() => setRetryNonce((value) => value + 1)}>Retry note</button></section></main>;
    }
    return <main className="archive-shell"><header className="masthead"><Link to="/" className="wordmark">CS PATCH NOTES</Link>{back}</header><p className="state" role="status">Loading note…</p></main>;
  }

  const { note } = view;
  return <main className="archive-shell note-page"><header className="masthead"><Link to="/" className="wordmark">CS PATCH NOTES</Link>{back}</header><article>
    <p className="eyebrow">{note.date} / {note.game === "cs2" ? "COUNTER-STRIKE 2" : "COUNTER-STRIKE: GLOBAL OFFENSIVE"}</p><h1>{note.title}</h1><SourceAction href={note.source_url} />
    <div className="note-body"><NoteMarkdown body={note.body} title={note.title} /></div>
  </article></main>;
}
