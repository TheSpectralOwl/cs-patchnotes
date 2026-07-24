const fs = require("node:fs");
const path = require("node:path");

function assertNoSymlinks(root) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Candidate corpus contains a symlink: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Candidate corpus is not a directory: ${root}`);

  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const filename = path.join(root, entry.name);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(`Candidate corpus contains a symlink: ${filename}`);
    if (stat.isDirectory()) assertNoSymlinks(filename);
  }
}

module.exports = { assertNoSymlinks };
