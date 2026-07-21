/**
 * The single `pipeline` CLI entrypoint.
 *
 * One greppable dispatch: `pipeline <subcommand>` reads `process.argv` and runs
 * the matching stage. The full `poll | backfill | parse | reindex | rebuild`
 * surface is wired here; each stage plugs into the same registry without
 * touching callers.
 *
 * Each subcommand module is loaded lazily via a runtime `import()` so a single
 * invocation only pulls in the stage it needs (and stages can be added
 * incrementally). On any failure we log and `process.exit(1)` — mirroring the
 * api entrypoint convention so a non-zero exit surfaces to the orchestrator.
 *
 * Config is read via `process.env.X ?? default` at the stage level — no dotenv
 * (compose `env_file` / Node `--env-file` is the established pattern).
 */

import { pathToFileURL } from "node:url";

interface Subcommand {
  /** Relative module specifier (kept as a variable so it resolves at runtime). */
  module: string;
  /** Exported runner name on that module. */
  runner: string;
}

export const COMMANDS: Record<string, Subcommand> = {
  poll: { module: "./poll.js", runner: "runPoll" },
  backfill: { module: "./poll.js", runner: "runBackfill" },
  parse: { module: "./parse.js", runner: "runParse" },
  reindex: { module: "./reindex.js", runner: "runReindex" },
  rebuild: { module: "./reindex.js", runner: "runRebuild" },
};

export async function main(): Promise<void> {
  const name = process.argv[2];

  if (!name || !(name in COMMANDS)) {
    const known = Object.keys(COMMANDS).join(" | ");
    throw new Error(
      name
        ? `Unknown subcommand "${name}". Known subcommands: ${known}`
        : `No subcommand given. Usage: pipeline <${known}>`,
    );
  }

  const { module: specifier, runner } = COMMANDS[name];
  const mod = (await import(specifier)) as Record<string, () => Promise<void>>;
  const run = mod[runner];

  if (typeof run !== "function") {
    throw new Error(`Subcommand "${name}" module "${specifier}" has no "${runner}" export.`);
  }

  await run();
}

/**
 * Only dispatch when this module is the process entrypoint (`node dist/cli.js`).
 * Guarding the auto-run keeps the command registry importable (e.g. by tests)
 * without triggering a real dispatch + `process.exit`.
 */
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
