import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Game = "csgo" | "cs2";

export type Note = {
  id: string;
  title: string;
  date: string;
  game: Game;
  steam_gid: string;
  source_url: string;
  source_sha256: string;
  body: string;
  duplicate_of?: string;
};

export type SearchHit = Pick<Note, "id" | "title" | "date" | "game" | "steam_gid" | "source_url"> & {
  score: number;
  matching_lines: string[];
  more_changes: number;
};

export type CorpusIndex = {
  notes: Note[];
  terms: Map<string, Array<[number, number]>>;
};

function parseFrontmatter(contents: string) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("Note is missing frontmatter");
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const rawValue = line.slice(separator + 2);
    try {
      frontmatter[key] = JSON.parse(rawValue);
    } catch {
      frontmatter[key] = rawValue;
    }
  }
  return { frontmatter, body: match[2] };
}

function tokens(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function compareDecimalIdentifiers(left: string, right: string) {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  return normalizedLeft.length - normalizedRight.length
    || normalizedLeft.localeCompare(normalizedRight)
    || left.localeCompare(right);
}

function verifyGeneratedBody(note: Note, generatedHash: string | undefined) {
  if (!generatedHash) throw new Error(`${note.id} is missing generated_sha256`);
  const actual = createHash("sha256").update(note.body).digest("hex");
  if (actual !== generatedHash) throw new Error(`${note.id} has changed outside the converter`);
}

export function loadCorpus(contentDir = process.env.CONTENT_DIR ?? resolve(process.cwd(), "..", "cs-patchnotes-content")): CorpusIndex {
  const notesDir = join(contentDir, "content", "notes");
  const notes = readdirSync(notesDir)
    .filter((filename) => filename.endsWith(".md"))
    .sort()
    .map((id) => {
      const { frontmatter, body } = parseFrontmatter(readFileSync(join(notesDir, id), "utf8"));
      const note: Note = {
        id,
        title: frontmatter.title,
        date: frontmatter.date,
        game: frontmatter.game as Game,
        steam_gid: frontmatter.steam_gid,
        source_url: frontmatter.source_url,
        source_sha256: frontmatter.source_sha256,
        body,
      };
      if (!note.title || !note.date || !note.game || !note.steam_gid || !note.source_url || !note.source_sha256) {
        throw new Error(`${id} has incomplete frontmatter`);
      }
      verifyGeneratedBody(note, frontmatter.generated_sha256);
      return note;
    });

  const canonicalByHash = new Map<string, Note>();
  for (const note of notes) {
    const canonical = canonicalByHash.get(note.source_sha256);
    if (!canonical || compareDecimalIdentifiers(note.steam_gid, canonical.steam_gid) < 0) canonicalByHash.set(note.source_sha256, note);
  }
  for (const note of notes) {
    const canonical = canonicalByHash.get(note.source_sha256);
    if (canonical && canonical.id !== note.id) note.duplicate_of = canonical.id;
  }

  const terms = new Map<string, Array<[number, number]>>();
  notes.forEach((note, noteIndex) => {
    const frequencies = new Map<string, number>();
    for (const token of tokens(`${note.title}\n${note.body}`)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [token, count] of frequencies) terms.set(token, [...(terms.get(token) ?? []), [noteIndex, count]]);
  });
  return { notes, terms };
}

function matchingLines(note: Note, queryTokens: string[]) {
  if (queryTokens.length === 0) return note.body.split("\n").filter((line) => line.startsWith("- ")).slice(0, 3);
  return note.body.split("\n").filter((line) => {
    const candidate = line.toLowerCase();
    return queryTokens.some((token) => candidate.includes(token));
  });
}

export function searchCorpus(index: CorpusIndex, query: string, filters: { game?: Game; from?: string; to?: string } = {}): SearchHit[] {
  const queryTokens = [...new Set(tokens(query))];
  const scores = new Map<number, number>();
  if (queryTokens.length === 0) index.notes.forEach((_, noteIndex) => scores.set(noteIndex, 0));
  for (const token of queryTokens) {
    for (const [noteIndex, count] of index.terms.get(token) ?? []) scores.set(noteIndex, (scores.get(noteIndex) ?? 0) + count);
  }
  return [...scores]
    .map(([noteIndex, score]) => ({ note: index.notes[noteIndex], score }))
    .filter(({ note }) => !note.duplicate_of)
    .filter(({ note }) => !filters.game || note.game === filters.game)
    .filter(({ note }) => !filters.from || note.date >= filters.from)
    .filter(({ note }) => !filters.to || note.date <= filters.to)
    .sort((left, right) => right.score - left.score || right.note.date.localeCompare(left.note.date))
    .map(({ note, score }) => {
      const lines = matchingLines(note, queryTokens);
      const changes = note.body.split("\n").filter((line) => /^\s*-\s+/.test(line));
      return {
        id: note.id,
        title: note.title,
        date: note.date,
        game: note.game,
        steam_gid: note.steam_gid,
        source_url: note.source_url,
        score,
        matching_lines: lines,
        more_changes: Math.max(0, changes.length - lines.length),
      };
    });
}

export class CorpusStore {
  #index: CorpusIndex;

  constructor(private readonly contentDir?: string) {
    this.#index = loadCorpus(contentDir);
  }

  reload() {
    const next = loadCorpus(this.contentDir);
    this.#index = next;
    return { notes: next.notes.length, terms: next.terms.size };
  }

  search(query: string, filters: { game?: Game; from?: string; to?: string }) {
    return searchCorpus(this.#index, query, filters);
  }

  note(id: string) {
    const requested = this.#index.notes.find((note) => note.id === id);
    if (!requested) return undefined;
    return requested.duplicate_of
      ? this.#index.notes.find((note) => note.id === requested.duplicate_of)
      : requested;
  }

  stats() {
    return { notes: this.#index.notes.length, visible_notes: this.#index.notes.filter((note) => !note.duplicate_of).length };
  }
}
