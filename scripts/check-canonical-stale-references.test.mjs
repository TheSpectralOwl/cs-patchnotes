import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSources,
  formatAuditResult,
} from "./check-canonical-stale-references.mjs";

test("rejects unexpected source and test references with exact safe locations", () => {
  const secret = "do-not-print-this-source-body";
  const result = auditSources(
    [
      {
        file: "packages/example/src/consumer.ts",
        source: `const value = updateId(${JSON.stringify(secret)});`,
      },
      {
        file: "packages/example/test/consumer.test.ts",
        source: "expect(buildLineDocs(database)).toEqual([]);",
      },
    ],
    { mode: "pre-removal", allowedLocations: [] },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpected, [
    {
      file: "packages/example/src/consumer.ts",
      line: 1,
      column: 15,
      token: "updateId",
    },
    {
      file: "packages/example/test/consumer.test.ts",
      line: 1,
      column: 8,
      token: "buildLineDocs",
    },
  ]);

  const output = formatAuditResult(result);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /packages\/example\/src\/consumer\.ts/);
  assert.match(output, /packages\/example\/test\/consumer\.test\.ts/);
});

test("requires every exact allowlisted occurrence in pre-removal mode", () => {
  const allowedLocations = [
    {
      file: "packages/example/src/declaration.ts",
      line: 1,
      column: 14,
      token: "updateId",
    },
  ];

  const present = auditSources(
    [{ file: allowedLocations[0].file, source: "export const updateId = value;" }],
    { mode: "pre-removal", allowedLocations },
  );
  assert.equal(present.ok, true);

  const missing = auditSources([], { mode: "pre-removal", allowedLocations });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingAllowed, allowedLocations);
});

test("strict mode rejects even an otherwise allowlisted declaration", () => {
  const source = {
    file: "packages/example/src/declaration.ts",
    source: "export interface UpdateRow {}",
  };
  const allowedLocations = [
    { file: source.file, line: 1, column: 18, token: "UpdateRow" },
  ];

  assert.equal(
    auditSources([source], { mode: "pre-removal", allowedLocations }).ok,
    true,
  );
  const strict = auditSources([source], { mode: "strict", allowedLocations });
  assert.equal(strict.ok, false);
  assert.deepEqual(strict.unexpected, allowedLocations);
});
