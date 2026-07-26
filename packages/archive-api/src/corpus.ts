import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  source_revision: string;
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
    source_revision: requiredFrontmatterString(frontmatter, "source_revision", id),
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
    const siblingGroupsBySection = new Map<ContextSection, ContextItem[][]>();

    for (const listItem of list.children ?? []) {
      if (listItem.type !== "listItem") continue;
      let localSection = section;
      const groupsBySection = new Map<ContextSection, ContextItem[]>();

      for (const child of listItem.children ?? []) {
        if (child.type === "heading") {
          localSection = requireSection(walkSupportedBlocks([child], localSection));
        } else if (child.type === "paragraph") {
          const item = addItem(requireSection(localSection), child, "change");
          const group = groupsBySection.get(localSection) ?? [];
          group.push(item);
          groupsBySection.set(localSection, group);
        } else if (child.type === "list") {
          walkList(child, localSection);
        } else if (child.type === "blockquote") {
          walkSupportedBlocks(child.children ?? [], localSection);
        }
      }

      for (const [groupSection, group] of groupsBySection) {
        const siblingGroups = siblingGroupsBySection.get(groupSection) ?? [];
        siblingGroups.push(group);
        siblingGroupsBySection.set(groupSection, siblingGroups);
      }
    }

    siblingGroupsBySection.forEach((siblingGroups) => {
      siblingGroups.forEach((group, siblingGroupIndex) => {
        group.forEach((item) => {
          item.siblingGroups = siblingGroups;
          item.siblingGroupIndex = siblingGroupIndex;
        });
      });
    });
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

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const STEAM_GID_PATTERN = /^[0-9]+$/;

type RawRecord = {
  gid: string;
  title: string;
  date: string;
  game: Game;
  content_kind: "patch_notes";
  body_format: "bbcode" | "plain_text";
  source_url: string;
  body: string;
  body_sha256: string;
};

type RevisionManifest = {
  gid: string;
  latest_revision: string;
  revisions: string[];
  note_id?: string;
  legacy_filename?: string;
  legacy_migration_revisions?: string[];
  override_revision?: string;
};

type RawLayout = {
  manifest: RevisionManifest;
  revisions: Map<string, RawRecord>;
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containedPath(root: string, relativePath: string) {
  const resolvedRoot = resolve(root);
  const filename = resolve(resolvedRoot, relativePath);
  const pathFromRoot = relative(resolvedRoot, filename);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`Path escapes its containing directory: ${relativePath}`);
  }
  return filename;
}

function readDirectory(directory: string, label: string, optional = false) {
  if (!existsSync(directory)) {
    if (optional) return [];
    throw new Error(`${label} directory is missing`);
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a directory`);
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
}

function assertNoSymlinks(root: string) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Candidate corpus is not a directory: ${root}`);
  for (const entry of readDirectory(root, "Candidate corpus")) {
    const filename = join(root, entry.name);
    const child = lstatSync(filename);
    if (child.isSymbolicLink()) throw new Error(`Candidate corpus contains a symlink: ${filename}`);
    if (child.isDirectory()) assertNoSymlinks(filename);
    else if (!child.isFile()) throw new Error(`Candidate corpus contains an unsupported filesystem entry: ${filename}`);
  }
}

function readJson(filename: string, label: string) {
  try {
    const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
    if (!isObject(value)) throw new Error("must be an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertManifest(value: Record<string, unknown>, gid: string, kind: string): RevisionManifest {
  const revisions = value.revisions;
  if (value.gid !== gid) throw new Error(`${kind} manifest gid does not match its directory: ${gid}`);
  if (!Array.isArray(revisions) || revisions.length === 0 || new Set(revisions).size !== revisions.length || !revisions.every((revision) => typeof revision === "string" && SHA256_PATTERN.test(revision))) {
    throw new Error(`${kind} manifest for ${gid} has invalid revisions`);
  }
  if (typeof value.latest_revision !== "string" || !SHA256_PATTERN.test(value.latest_revision) || !revisions.includes(value.latest_revision)) {
    throw new Error(`${kind} manifest for ${gid} has an invalid latest_revision`);
  }
  return {
    gid,
    latest_revision: value.latest_revision,
    revisions,
    ...(typeof value.note_id === "string" ? { note_id: value.note_id } : {}),
    ...(typeof value.legacy_filename === "string" ? { legacy_filename: value.legacy_filename } : {}),
    ...(Array.isArray(value.legacy_migration_revisions) ? { legacy_migration_revisions: value.legacy_migration_revisions as string[] } : {}),
    ...(typeof value.override_revision === "string" ? { override_revision: value.override_revision } : {}),
  };
}

function isCanonicalDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validatedRawRecord(value: Record<string, unknown>, gid: string, label: string): RawRecord {
  const required = ["gid", "title", "game", "content_kind", "body_format", "source_url", "body", "body_sha256"] as const;
  if (required.some((field) => typeof value[field] !== "string" || value[field].length === 0) || !isCanonicalDate(value.date)) {
    throw new Error(`${label} is malformed`);
  }
  const raw = value as RawRecord;
  if (raw.gid !== gid || (raw.game !== "csgo" && raw.game !== "cs2") || raw.content_kind !== "patch_notes" || (raw.body_format !== "bbcode" && raw.body_format !== "plain_text") || !SHA256_PATTERN.test(raw.body_sha256) || sha256(raw.body) !== raw.body_sha256) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

function assertPublicNoteId(noteId: string | undefined, gid: string) {
  if (!noteId || !noteId.endsWith(".md") || noteId !== noteId.split(/[\\/]/).pop()) {
    throw new Error(`Note manifest note_id for ${gid} must be a Markdown filename`);
  }
  return noteId;
}

function verifyNoteEvidence(id: string, contents: string, raw: RawRecord, gid: string, revision: string, legacyRevisions: string[]) {
  const { frontmatter, body } = parseFrontmatter(contents);
  if (frontmatter.source_revision === undefined && legacyRevisions.includes(revision)) frontmatter.source_revision = revision;
  const note = validatedNote(id, frontmatter, body);
  verifyGeneratedBody(note, typeof frontmatter.generated_sha256 === "string" ? frontmatter.generated_sha256 : undefined);
  if (note.steam_gid !== gid || note.source_sha256 !== raw.body_sha256 || note.source_revision !== revision
    || note.title !== raw.title || note.date !== raw.date || note.game !== raw.game || note.source_url !== raw.source_url
    || frontmatter.content_kind !== raw.content_kind || frontmatter.body_format !== raw.body_format) {
    throw new Error(`${id} provenance does not match raw revision ${gid}/${revision}`);
  }
  return note;
}

export function loadCorpus(contentDir = process.env.CONTENT_DIR ?? resolve(process.cwd(), "..", "cs-patchnotes-content-v2")): CorpusIndex {
  assertNoSymlinks(contentDir);
  const rawRoot = join(contentDir, "raw", "steam");
  const rawLayouts = new Map<string, RawLayout>();
  for (const entry of readDirectory(rawRoot, "Raw Steam", true)) {
    if (!entry.isDirectory() || !STEAM_GID_PATTERN.test(entry.name)) throw new Error(`Invalid raw Steam layout entry: ${entry.name}`);
    const gid = entry.name;
    const directory = containedPath(rawRoot, gid);
    const entries = readDirectory(directory, `Raw revision ${gid}`);
    if (entries.some((child) => !child.isFile() || (child.name !== "index.json" && !new RegExp(`^${SHA256_PATTERN.source.slice(1, -1)}\\.json$`).test(child.name)))) throw new Error(`Invalid raw revision layout for ${gid}`);
    const manifest = assertManifest(readJson(containedPath(directory, "index.json"), `Raw manifest for ${gid}`), gid, "Raw");
    const filenames = entries.filter((child) => child.name.endsWith(".json") && child.name !== "index.json").map((child) => child.name.slice(0, -5));
    if (filenames.length !== manifest.revisions.length || filenames.some((revision) => !manifest.revisions.includes(revision))) throw new Error(`Raw manifest for ${gid} does not match its revision files`);
    const revisions = new Map<string, RawRecord>();
    for (const revision of manifest.revisions) {
      const filename = containedPath(directory, `${revision}.json`);
      const bytes = readFileSync(filename);
      if (sha256(bytes) !== revision) throw new Error(`Raw revision ${gid}/${revision} does not match its filename hash`);
      revisions.set(revision, validatedRawRecord(readJson(filename, `Raw revision ${gid}/${revision}`), gid, `Raw revision ${gid}/${revision}`));
    }
    rawLayouts.set(gid, { manifest, revisions });
  }

  const notesRoot = join(contentDir, "content", "notes");
  const notes: Note[] = [];
  const noteIds = new Set<string>();
  const noteLayouts = new Map<string, RevisionManifest>();
  for (const entry of readDirectory(notesRoot, "Note", true)) {
    if (!entry.isDirectory() || !STEAM_GID_PATTERN.test(entry.name)) throw new Error(`Invalid note layout entry: ${entry.name}`);
    const gid = entry.name;
    const rawLayout = rawLayouts.get(gid);
    if (!rawLayout) throw new Error(`Note revisions for ${gid} have no raw source`);
    const directory = containedPath(notesRoot, gid);
    const entries = readDirectory(directory, `Note revision ${gid}`);
    if (entries.some((child) => !child.isFile() || (child.name !== "index.json" && !new RegExp(`^${SHA256_PATTERN.source.slice(1, -1)}\\.md$`).test(child.name)))) throw new Error(`Invalid note revision layout for ${gid}`);
    const manifest = assertManifest(readJson(containedPath(directory, "index.json"), `Note manifest for ${gid}`), gid, "Note");
    const noteId = assertPublicNoteId(manifest.note_id, gid);
    if (manifest.legacy_filename !== noteId || manifest.latest_revision !== rawLayout.manifest.latest_revision || !manifest.revisions.every((revision) => rawLayout.revisions.has(revision))) throw new Error(`Note manifest for ${gid} does not match its source evidence`);
    if (manifest.legacy_migration_revisions && (!manifest.legacy_migration_revisions.every((revision) => manifest.revisions.includes(revision)))) throw new Error(`Note manifest for ${gid} has invalid legacy migration revisions`);
    if (manifest.override_revision !== undefined && !rawLayout.revisions.has(manifest.override_revision)) throw new Error(`Note manifest for ${gid} has an invalid override revision`);
    const filenames = entries.filter((child) => child.name.endsWith(".md") && child.name !== "index.json").map((child) => child.name.slice(0, -3));
    if (filenames.length !== manifest.revisions.length || filenames.some((revision) => !manifest.revisions.includes(revision))) throw new Error(`Note manifest for ${gid} does not match its revision files`);
    if (noteIds.has(noteId)) throw new Error(`More than one GID claims public note ID: ${noteId}`);
    noteIds.add(noteId);
    for (const revision of manifest.revisions) {
      verifyNoteEvidence(noteId, readFileSync(containedPath(directory, `${revision}.md`), "utf8"), rawLayout.revisions.get(revision)!, gid, revision, manifest.legacy_migration_revisions ?? []);
    }
    noteLayouts.set(gid, manifest);
  }
  if (noteLayouts.size !== rawLayouts.size) {
    for (const gid of rawLayouts.keys()) if (!noteLayouts.has(gid)) throw new Error(`Raw revision ${gid} has no note manifest`);
  }

  const overridesRoot = join(contentDir, "overrides");
  const overrides = new Map<string, Note>();
  for (const entry of readDirectory(overridesRoot, "Override", true)) {
    const gid = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : "";
    const rawLayout = rawLayouts.get(gid);
    const manifest = noteLayouts.get(gid);
    if (!entry.isFile() || !STEAM_GID_PATTERN.test(gid) || !rawLayout || !manifest?.override_revision) throw new Error(`Override ${entry.name} is not mapped by a note manifest`);
    overrides.set(gid, verifyNoteEvidence(manifest.note_id!, readFileSync(containedPath(overridesRoot, entry.name), "utf8"), rawLayout.revisions.get(manifest.override_revision)!, gid, manifest.override_revision, manifest.legacy_migration_revisions ?? []));
  }
  for (const [gid, manifest] of noteLayouts) {
    if (manifest.override_revision !== undefined && !overrides.has(gid)) throw new Error(`Note manifest for ${gid} selects a missing override`);
    const rawLayout = rawLayouts.get(gid)!;
    const effective = overrides.get(gid)
      ?? verifyNoteEvidence(manifest.note_id!, readFileSync(containedPath(join(notesRoot, gid), `${rawLayout.manifest.latest_revision}.md`), "utf8"), rawLayout.revisions.get(rawLayout.manifest.latest_revision)!, gid, rawLayout.manifest.latest_revision, manifest.legacy_migration_revisions ?? []);
    notes.push(effective);
  }

  const canonicalByHash = new Map<string, Note>();
  for (const note of notes) {
    const hash = noteBodySha256(note);
    const canonical = canonicalByHash.get(hash);
    if (!canonical || compareDecimalIdentifiers(note.steam_gid, canonical.steam_gid) < 0) canonicalByHash.set(hash, note);
  }
  for (const note of notes) {
    const canonical = canonicalByHash.get(noteBodySha256(note));
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

function activeContentDirectory(revisionRoot: string) {
  const marker = join(revisionRoot, "active");
  let sha: string;
  try {
    const markerStat = lstatSync(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("not a regular file");
    sha = readFileSync(marker, "utf8").trim();
  } catch {
    throw new Error(`Active content marker is missing: ${marker}`);
  }
  if (!GIT_SHA_PATTERN.test(sha)) throw new Error("Active content marker must contain one full lowercase Git SHA");
  const worktrees = join(revisionRoot, "worktrees");
  const contentDir = containedPath(worktrees, sha);
  if (!existsSync(contentDir) || !lstatSync(contentDir).isDirectory() || lstatSync(contentDir).isSymbolicLink()) {
    throw new Error(`Active content worktree is unavailable for ${sha}`);
  }
  return { sha, contentDir };
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
  const fallback = queryTokens.length === 0
    ? sections.find((section) => section.items.some((item) => item.kind === "change"))
      ?? sections.find((section) => section.items.some((item) => item.kind === "prose"))
      ?? sections.find((section) => section.items.length > 0)
    : sections.find((section) => section.items.length > 0);
  if (!fallback) return [];
  const item = queryTokens.length === 0
    ? fallback.items.find((candidate) => candidate.kind === "change") ?? fallback.items.find((candidate) => candidate.kind === "prose") ?? fallback.items[0]
    : fallback.items[0];
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
  #activeSha: string;

  constructor(private readonly revisionRoot = process.env.CONTENT_REVISION_ROOT ?? resolve(process.cwd(), "..", "cs-patchnotes-content-revisions")) {
    const active = activeContentDirectory(revisionRoot);
    this.#index = loadCorpus(active.contentDir);
    this.#activeSha = active.sha;
  }

  reload(expectedSha: string) {
    if (!GIT_SHA_PATTERN.test(expectedSha)) throw new Error("Reload requires one full lowercase Git SHA");
    const active = activeContentDirectory(this.revisionRoot);
    if (active.sha !== expectedSha) throw new Error(`Active content SHA does not match requested reload SHA: ${expectedSha}`);
    const next = loadCorpus(active.contentDir);
    this.#index = next;
    this.#activeSha = active.sha;
    return { notes: next.notes.length, terms: next.terms.size, content_sha: this.#activeSha };
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

  activeSha() {
    return this.#activeSha;
  }
}
