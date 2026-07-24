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
  return { id, requestId: 0, error: "" };
}

describe("noteViewReducer", () => {
  it("ignores an earlier response that resolves after a later navigation", () => {
    const secondRequest = noteViewReducer(
      noteViewReducer(initialState("first"), { type: "request", id: "second", requestId: 1 }),
      { type: "success", id: "first", requestId: 1, note: firstNote },
    );

    expect(secondRequest).toEqual({ id: "second", requestId: 1, error: "" });
    expect(noteViewReducer(secondRequest, { type: "success", id: "second", requestId: 1, note: secondNote })).toEqual({
      id: "second",
      requestId: 1,
      note: secondNote,
      error: "",
    });
  });

  it("clears a previous not-found error before a valid note response", () => {
    const unavailable = noteViewReducer(initialState("missing"), {
      type: "failure",
      id: "missing",
      requestId: 0,
      error: "This note is unavailable.",
    });
    const nextRequest = noteViewReducer(unavailable, { type: "request", id: "available", requestId: 1 });

    expect(nextRequest).toEqual({ id: "available", requestId: 1, error: "" });
    expect(noteViewReducer(nextRequest, { type: "success", id: "available", requestId: 1, note: secondNote })).toEqual({
      id: "available",
      requestId: 1,
      note: secondNote,
      error: "",
    });
  });

  it("starts a fresh same-note request for retry and ignores its earlier response", () => {
    const failed = noteViewReducer(initialState("missing"), {
      type: "failure",
      id: "missing",
      requestId: 0,
      error: "This note is unavailable.",
    });
    const retrying = noteViewReducer(failed, { type: "request", id: "missing", requestId: 1 });
    const lateFirstResponse = noteViewReducer(retrying, { type: "success", id: "missing", requestId: 0, note: firstNote });

    expect(retrying).toEqual({ id: "missing", requestId: 1, error: "" });
    expect(lateFirstResponse).toEqual(retrying);
    expect(noteViewReducer(lateFirstResponse, { type: "success", id: "missing", requestId: 1, note: secondNote })).toMatchObject({
      id: "missing",
      requestId: 1,
      note: secondNote,
    });
  });
});
