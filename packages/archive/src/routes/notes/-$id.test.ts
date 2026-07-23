import { describe, expect, it } from "vitest";
import { noteViewReducer, type Note, type NoteViewState } from "./$id";

const firstNote: Note = {
  title: "First note",
  date: "2026-01-01",
  game: "cs2",
  source_url: "https://store.steampowered.com/news/app/730",
  body: "First body",
};

const secondNote: Note = { ...firstNote, title: "Second note", body: "Second body" };

function initialState(id: string): NoteViewState {
  return { id, error: "" };
}

describe("noteViewReducer", () => {
  it("ignores an earlier response that resolves after a later navigation", () => {
    const secondRequest = noteViewReducer(
      noteViewReducer(initialState("first"), { type: "request", id: "second" }),
      { type: "success", id: "first", note: firstNote },
    );

    expect(secondRequest).toEqual(initialState("second"));
    expect(noteViewReducer(secondRequest, { type: "success", id: "second", note: secondNote })).toEqual({
      id: "second",
      note: secondNote,
      error: "",
    });
  });

  it("clears a previous not-found error before a valid note response", () => {
    const unavailable = noteViewReducer(initialState("missing"), {
      type: "failure",
      id: "missing",
      error: "This note is unavailable.",
    });
    const nextRequest = noteViewReducer(unavailable, { type: "request", id: "available" });

    expect(nextRequest).toEqual(initialState("available"));
    expect(noteViewReducer(nextRequest, { type: "success", id: "available", note: secondNote })).toEqual({
      id: "available",
      note: secondNote,
      error: "",
    });
  });
});
