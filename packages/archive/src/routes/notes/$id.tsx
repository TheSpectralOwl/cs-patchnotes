import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import { NoteMarkdown, SourceAction } from "../../components/note-markdown";

export type Note = { title: string; date: string; game: string; source_url: string; body: string };

export type NoteViewState = {
  id: string;
  note?: Note;
  error: string;
};

export type NoteViewAction =
  | { type: "request"; id: string }
  | { type: "success"; id: string; note: Note }
  | { type: "failure"; id: string; error: string };

export function noteViewReducer(state: NoteViewState, action: NoteViewAction): NoteViewState {
  if (action.type === "request") return { id: action.id, error: "" };
  if (action.id !== state.id) return state;

  return action.type === "success"
    ? { ...state, note: action.note }
    : { ...state, error: action.error };
}

export const Route = createFileRoute("/notes/$id")({ component: NotePage });

function NotePage() {
  const { id } = Route.useParams();
  const [view, dispatch] = useReducer(noteViewReducer, { id, error: "" });

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: "request", id });

    void fetch(`/api/notes/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("This note is unavailable.");
        return response.json() as Promise<Note>;
      })
      .then((note) => {
        if (!controller.signal.aborted) dispatch({ type: "success", id, note });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({
            type: "failure",
            id,
            error: reason instanceof Error ? reason.message : "This note is unavailable.",
          });
        }
      });

    return () => controller.abort();
  }, [id]);

  if (view.id !== id || !view.note) {
    if (view.id === id && view.error) {
      return <main className="archive-shell"><p className="state error">{view.error}</p></main>;
    }

    return <main className="archive-shell"><p className="state">Loading note...</p></main>;
  }

  const { note } = view;
  return <main className="archive-shell note-page"><header className="masthead"><Link to="/" className="wordmark">CS PATCH NOTES</Link><Link to="/">BACK TO ARCHIVE</Link></header><article>
    <p className="eyebrow">{note.date} / {note.game === "cs2" ? "COUNTER-STRIKE 2" : "COUNTER-STRIKE: GLOBAL OFFENSIVE"}</p><h1>{note.title}</h1><SourceAction href={note.source_url} />
    <div className="note-body"><NoteMarkdown body={note.body} title={note.title} /></div>
  </article></main>;
}
