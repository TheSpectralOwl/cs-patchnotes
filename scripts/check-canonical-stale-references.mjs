import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TRANSITIONAL_TOKENS = Object.freeze([
  "UpdateRow",
  "SectionRow",
  "LineRow",
  "MeiliLineDoc",
  "updateId",
  "sectionId",
  "lineId",
  "buildLineDocs",
  "parseStoredUpdates",
  "parseBody",
  "parseCs2Body",
  "detectEra",
  "patch_lines",
  "notesRoutes",
]);

const ALLOWED_PRE_REMOVAL_LOCATIONS = Object.freeze([
  ["packages/pipeline/src/parse/bbcode.ts", 7, 5, "parseBody"],
  ["packages/pipeline/src/parse/bbcode.ts", 7, 34, "parseCs2Body"],
  ["packages/pipeline/src/parse/bbcode.ts", 42, 47, "detectEra"],
  ["packages/pipeline/src/parse/bbcode.ts", 246, 17, "detectEra"],
  ["packages/pipeline/src/parse/bbcode.ts", 262, 17, "parseBody"],
  ["packages/pipeline/src/parse/bbcode.ts", 263, 15, "detectEra"],
  ["packages/pipeline/src/parse/bbcode.ts", 270, 14, "parseBody"],
  ["packages/pipeline/src/parse/bbcode.ts", 273, 17, "parseCs2Body"],
  ["packages/pipeline/src/parse/bbcode.ts", 274, 10, "parseBody"],
  ["packages/pipeline/src/parse.ts", 8, 3, "sectionId"],
  ["packages/pipeline/src/parse.ts", 9, 3, "lineId"],
  ["packages/pipeline/src/parse.ts", 12, 10, "parseBody"],
  ["packages/pipeline/src/parse.ts", 12, 21, "detectEra"],
  ["packages/pipeline/src/parse.ts", 434, 17, "parseStoredUpdates"],
  ["packages/pipeline/src/parse.ts", 479, 22, "parseBody"],
  ["packages/pipeline/src/parse.ts", 483, 21, "sectionId"],
  ["packages/pipeline/src/parse.ts", 494, 17, "lineId"],
  ["packages/pipeline/src/parse.ts", 519, 21, "detectEra"],
  ["packages/pipeline/src/reindex.ts", 8, 8, "MeiliLineDoc"],
  ["packages/pipeline/src/reindex.ts", 106, 17, "buildLineDocs"],
  ["packages/pipeline/src/reindex.ts", 106, 46, "MeiliLineDoc"],
  ["packages/shared/src/db/ids.ts", 48, 14, "updateId"],
  ["packages/shared/src/db/ids.ts", 51, 14, "sectionId"],
  ["packages/shared/src/db/ids.ts", 51, 27, "updateId"],
  ["packages/shared/src/db/ids.ts", 51, 70, "updateId"],
  ["packages/shared/src/db/ids.ts", 54, 14, "lineId"],
  ["packages/shared/src/db/ids.ts", 54, 24, "sectionId"],
  ["packages/shared/src/db/ids.ts", 54, 68, "sectionId"],
  ["packages/shared/src/types.ts", 6, 38, "MeiliLineDoc"],
  ["packages/shared/src/types.ts", 151, 18, "UpdateRow"],
  ["packages/shared/src/types.ts", 170, 18, "SectionRow"],
  ["packages/shared/src/types.ts", 180, 18, "LineRow"],
  ["packages/shared/src/types.ts", 197, 37, "patch_lines"],
  ["packages/shared/src/types.ts", 203, 18, "MeiliLineDoc"],
  ["packages/shared/test/ids.test.ts", 7, 3, "lineId"],
  ["packages/shared/test/ids.test.ts", 8, 3, "sectionId"],
  ["packages/shared/test/ids.test.ts", 9, 3, "updateId"],
  ["packages/shared/test/ids.test.ts", 37, 7, "updateId"],
  ["packages/shared/test/ids.test.ts", 38, 10, "updateId"],
  ["packages/shared/test/ids.test.ts", 39, 10, "updateId"],
  ["packages/shared/test/ids.test.ts", 39, 30, "updateId"],
  ["packages/shared/test/ids.test.ts", 42, 7, "sectionId"],
  ["packages/shared/test/ids.test.ts", 42, 21, "lineId"],
  ["packages/shared/test/ids.test.ts", 43, 10, "sectionId"],
  ["packages/shared/test/ids.test.ts", 43, 34, "sectionId"],
  ["packages/shared/test/ids.test.ts", 44, 10, "lineId"],
  ["packages/shared/test/ids.test.ts", 44, 33, "lineId"],
  ["packages/shared/test/ids.test.ts", 48, 10, "lineId"],
  ["packages/shared/test/ids.test.ts", 48, 17, "sectionId"],
  ["packages/shared/test/ids.test.ts", 48, 27, "updateId"],
  ["packages/shared/test/ids.test.ts", 52, 14, "lineId"],
  ["packages/shared/test/ids.test.ts", 52, 21, "sectionId"],
  ["packages/shared/test/ids.test.ts", 52, 31, "updateId"],
  ["packages/shared/test/ids.test.ts", 57, 10, "sectionId"],
  ["packages/shared/test/ids.test.ts", 57, 38, "sectionId"],
  ["packages/shared/test/ids.test.ts", 58, 10, "lineId"],
  ["packages/shared/test/ids.test.ts", 58, 37, "lineId"],
].map(([file, line, column, token]) => ({ file, line, column, token })));

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const TOKEN_PATTERN = new RegExp(
  `\\b(?:${TRANSITIONAL_TOKENS.map(escapeRegExp).join("|")})\\b`,
  "g",
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function locationKey(location) {
  return `${location.file}\u0000${location.line}\u0000${location.column}\u0000${location.token}`;
}

function compareLocations(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.token.localeCompare(right.token)
  );
}

function occurrencesInSource(file, source) {
  const occurrences = [];
  TOKEN_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(TOKEN_PATTERN)) {
    const prefix = source.slice(0, match.index);
    const lastNewline = prefix.lastIndexOf("\n");
    occurrences.push({
      file,
      line: prefix.split("\n").length,
      column: match.index - lastNewline,
      token: match[0],
    });
  }
  return occurrences;
}

export function auditSources(
  sources,
  { mode = "pre-removal", allowedLocations = ALLOWED_PRE_REMOVAL_LOCATIONS } = {},
) {
  if (mode !== "pre-removal" && mode !== "strict") {
    throw new TypeError(`Unknown audit mode: ${mode}`);
  }

  const occurrences = [...sources]
    .sort((left, right) => left.file.localeCompare(right.file))
    .flatMap(({ file, source }) => occurrencesInSource(file, source))
    .sort(compareLocations);
  const permitted = mode === "pre-removal" ? allowedLocations : [];
  const permittedKeys = new Set(permitted.map(locationKey));
  const occurrenceKeys = new Set(occurrences.map(locationKey));
  const unexpected = occurrences.filter((location) => !permittedKeys.has(locationKey(location)));
  const missingAllowed =
    mode === "pre-removal"
      ? permitted.filter((location) => !occurrenceKeys.has(locationKey(location))).sort(compareLocations)
      : [];

  return {
    ok: unexpected.length === 0 && missingAllowed.length === 0,
    mode,
    scannedFiles: sources.length,
    occurrences: occurrences.length,
    unexpected,
    missingAllowed,
  };
}

async function walk(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && TYPESCRIPT_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export async function scanWorkspace(projectRoot, { mode = "pre-removal" } = {}) {
  const packagesRoot = resolve(projectRoot, "packages");
  const files = (await walk(packagesRoot)).filter((path) => {
    const file = relative(projectRoot, path).split(sep).join("/");
    return /^packages\/[^/]+\/(?:src|test)\//.test(file);
  });
  const sources = await Promise.all(
    files.map(async (path) => ({
      file: relative(projectRoot, path).split(sep).join("/"),
      source: await readFile(path, "utf8"),
    })),
  );
  return auditSources(sources, { mode });
}

export function formatAuditResult(result) {
  return JSON.stringify(result, null, 2);
}

async function main() {
  const argumentsSet = new Set(process.argv.slice(2));
  const unknown = [...argumentsSet].filter((argument) => argument !== "--strict").sort();
  if (unknown.length > 0) {
    console.error(JSON.stringify({ ok: false, error: "unknown_arguments", arguments: unknown }));
    process.exitCode = 2;
    return;
  }

  const mode = argumentsSet.has("--strict") ? "strict" : "pre-removal";
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await scanWorkspace(projectRoot, { mode });
  const output = formatAuditResult(result);
  (result.ok ? console.log : console.error)(output);
  if (!result.ok) process.exitCode = 1;
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "Audit failed",
      }),
    );
    process.exitCode = 1;
  });
}
