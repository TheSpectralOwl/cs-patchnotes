import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { remark } from "remark";

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

export type PreviewItem = {
  markdown: string;
  kind: "change" | "prose" | "heading";
  matched: boolean;
};

export type PreviewSection = {
  heading: string;
  items: PreviewItem[];
};

export type SearchHit = Pick<Note, "id" | "title" | "date" | "game" | "steam_gid" | "source_url"> & {
  body_sha256: string;
  score: number;
  sections: PreviewSection[];
};

type PositionedNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: PositionedNode[];
};

type ContextItem = Omit<PreviewItem, "matched"> & {
  order: number;
  siblingGroups?: ContextItem[][];
  siblingGroupIndex?: number;
};

type ContextSection = {
  heading: string;
  items: ContextItem[];
};

export const MAX_PARSER_INPUT_BYTES = 1024 * 1024;

export type CorpusIndex = {
  notes: Note[];
  terms: Map<string, Array<[number, number]>>;
  contexts: ContextSection[][];
};

function parseFrontmatter(contents: string) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("Note is missing frontmatter");
  const frontmatter: Record<string, unknown> = {};
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

function requiredFrontmatterString(frontmatter: Record<string, unknown>, field: string, id: string) {
  const value = frontmatter[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${id} has incomplete frontmatter`);
  return value;
}

function validatedNote(id: string, frontmatter: Record<string, unknown>, body: string): Note {
  const game = requiredFrontmatterString(frontmatter, "game", id);
  if (game !== "csgo" && game !== "cs2") throw new Error(`${id} has invalid game frontmatter`);
  return {
    id,
    title: requiredFrontmatterString(frontmatter, "title", id),
    date: requiredFrontmatterString(frontmatter, "date", id),
    game,
    steam_gid: requiredFrontmatterString(frontmatter, "steam_gid", id),
    source_url: requiredFrontmatterString(frontmatter, "source_url", id),
    source_sha256: requiredFrontmatterString(frontmatter, "source_sha256", id),
    body,
  };
}

function tokens(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function sourceSlice(body: string, node: PositionedNode) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error("Markdown parser returned a node without source positions");
  return body.slice(start, end);
}

function inlineSourceSlice(body: string, node: PositionedNode) {
  const children = node.children ?? [];
  if (children.length === 0) return sourceSlice(body, node);
  const first = children[0];
  const last = children[children.length - 1];
  const start = first.position?.start.offset;
  const end = last.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error("Markdown parser returned inline content without source positions");
  return body.slice(start, end);
}

function contextualSections(body: string): ContextSection[] {
  if (Buffer.byteLength(body, "utf8") > MAX_PARSER_INPUT_BYTES) {
    throw new Error(`Note body exceeds the 1 MiB parser input ceiling (${MAX_PARSER_INPUT_BYTES} bytes)`);
  }

  const tree = remark().parse(body) as unknown as PositionedNode;
  const sections: ContextSection[] = [];
  const requireSection = (section: ContextSection | undefined) => {
    if (!section) throw new Error("Searchable Markdown content must have a preceding authored heading");
    return section;
  };

  const addItem = (section: ContextSection, node: PositionedNode, kind: PreviewItem["kind"]) => {
    const markdown = inlineSourceSlice(body, node);
    const order = node.position?.start.offset;
    if (order === undefined) throw new Error("Markdown parser returned a node without source positions");
    const item: ContextItem = { markdown, kind, order };
    section.items.push(item);
    return item;
  };

  const walkSupportedBlocks = (nodes: PositionedNode[], initialSection: ContextSection | undefined) => {
    let current = initialSection;
    for (const node of nodes) {
      if (node.type === "heading") {
        current = { heading: inlineSourceSlice(body, node), items: [] };
        sections.push(current);
        addItem(current, node, "heading");
      } else if (node.type === "paragraph") {
        addItem(requireSection(current), node, "prose");
      } else if (node.type === "list") {
        walkList(node, current);
      } else if (node.type === "blockquote") {
        walkSupportedBlocks(node.children ?? [], current);
      }
    }
    return current;
  };

  const walkList = (list: PositionedNode, current: ContextSection | undefined) => {
    const section = requireSection(current);
    const siblingGroups: ContextItem[][] = [];
    const nestedBlocks: PositionedNode[] = [];

    for (const listItem of list.children ?? []) {
      if (listItem.type !== "listItem") continue;
      const group = (listItem.children ?? [])
        .filter((child) => child.type === "paragraph")
        .map((paragraph) => addItem(section, paragraph, "change"));
      if (group.length > 0) siblingGroups.push(group);
      nestedBlocks.push(...(listItem.children ?? []).filter((child) => child.type !== "paragraph"));
    }

    siblingGroups.forEach((group, siblingGroupIndex) => {
      group.forEach((item) => {
        item.siblingGroups = siblingGroups;
        item.siblingGroupIndex = siblingGroupIndex;
      });
    });

    walkSupportedBlocks(nestedBlocks, section);
  };

  walkSupportedBlocks(tree.children ?? [], undefined);

  return sections;
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
  const actual = noteBodySha256(note);
  if (actual !== generatedHash) throw new Error(`${note.id} has changed outside the converter`);
}

export function noteBodySha256(note: Pick<Note, "body">) {
  return createHash("sha256").update(note.body).digest("hex");
}

export function loadCorpus(contentDir = process.env.CONTENT_DIR ?? resolve(process.cwd(), "..", "cs-patchnotes-content")): CorpusIndex {
  const notesDir = join(contentDir, "content", "notes");
  const notes = readdirSync(notesDir)
    .filter((filename) => filename.endsWith(".md"))
    .sort()
    .map((id) => {
      const { frontmatter, body } = parseFrontmatter(readFileSync(join(notesDir, id), "utf8"));
      const note = validatedNote(id, frontmatter, body);
      const generatedHash = frontmatter.generated_sha256;
      verifyGeneratedBody(note, typeof generatedHash === "string" ? generatedHash : undefined);
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
  const contexts = notes.map((note) => contextualSections(note.body));
  notes.forEach((note, noteIndex) => {
    const frequencies = new Map<string, number>();
    const contextualMarkdown = contexts[noteIndex]
      .flatMap((section) => section.items)
      .map((item) => item.markdown)
      .join("\n");
    for (const token of tokens(`${note.title}\n${contextualMarkdown}`)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [token, count] of frequencies) terms.set(token, [...(terms.get(token) ?? []), [noteIndex, count]]);
  });
  return { notes, terms, contexts };
}

function matchesTokens(markdown: string, queryTokens: string[]) {
  const fragmentTokens = new Set(tokens(markdown));
  return queryTokens.some((token) => fragmentTokens.has(token));
}

function nearestChange(items: ContextItem[], matched: ContextItem) {
  return items
    .filter((item) => item.kind === "change")
    .sort((left, right) => Math.abs(left.order - matched.order) - Math.abs(right.order - matched.order))[0];
}

function projectSections(sections: ContextSection[], queryTokens: string[], allowFallback: boolean): PreviewSection[] {
  const matchedSections = sections.flatMap((section) => {
    const matched = queryTokens.length === 0 ? [] : section.items.filter((item) => matchesTokens(item.markdown, queryTokens));
    if (matched.length === 0) return [];

    const selected = new Set<ContextItem>();
    for (const item of matched) {
      selected.add(item);
      if (item.kind === "change") {
        const siblings = item.siblingGroups;
        const index = item.siblingGroupIndex;
        if (siblings && index !== undefined) {
          for (const sibling of siblings[index] ?? []) selected.add(sibling);
          for (const sibling of siblings[index - 1] ?? []) selected.add(sibling);
          for (const sibling of siblings[index + 1] ?? []) selected.add(sibling);
        }
      } else {
        const change = nearestChange(section.items, item);
        if (change) selected.add(change);
      }
    }

    return [{
      heading: section.heading,
      items: [...selected]
        .sort((left, right) => left.order - right.order)
        .map((item) => ({ markdown: item.markdown, kind: item.kind, matched: matched.includes(item) })),
    }];
  });

  if (matchedSections.length > 0 || !allowFallback) return matchedSections;
  const fallback = sections.find((section) => section.items.length > 0);
  if (!fallback) return [];
  const item = fallback.items[0];
  return [{ heading: fallback.heading, items: [{ markdown: item.markdown, kind: item.kind, matched: false }] }];
}

export function searchCorpus(index: CorpusIndex, query: string, filters: { game?: Game; from?: string; to?: string } = {}): SearchHit[] {
  const queryTokens = [...new Set(tokens(query))];
  const scores = new Map<number, number>();
  if (queryTokens.length === 0) index.notes.forEach((_, noteIndex) => scores.set(noteIndex, 0));
  for (const token of queryTokens) {
    for (const [noteIndex, count] of index.terms.get(token) ?? []) scores.set(noteIndex, (scores.get(noteIndex) ?? 0) + count);
  }
  return [...scores]
    .map(([noteIndex, score]) => ({
      note: index.notes[noteIndex],
      context: index.contexts[noteIndex],
      score,
      allowFallback: queryTokens.length === 0 || matchesTokens(index.notes[noteIndex].title, queryTokens),
    }))
    .filter(({ note }) => !note.duplicate_of)
    .filter(({ note }) => !filters.game || note.game === filters.game)
    .filter(({ note }) => !filters.from || note.date >= filters.from)
    .filter(({ note }) => !filters.to || note.date <= filters.to)
    .sort((left, right) => right.score - left.score || right.note.date.localeCompare(left.note.date))
    .map(({ note, context, score, allowFallback }) => ({
        id: note.id,
        title: note.title,
        date: note.date,
        game: note.game,
        steam_gid: note.steam_gid,
        source_url: note.source_url,
        body_sha256: noteBodySha256(note),
        score,
        sections: projectSections(context, queryTokens, allowFallback),
      }));
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
