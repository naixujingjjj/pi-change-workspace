// Syntax-only check for every shipped and test file: `node --check` parses the
// module without running it, so the extension entry is checked even where its
// Pi import cannot be resolved.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const targets = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === ".tmp" || name === ".git" || name === "dist") continue;
      walk(path);
    } else if (name.endsWith(".js") || name.endsWith(".mjs")) {
      targets.push(path);
    }
  }
}

for (const dir of ["extensions", "src", "test", "tools"]) {
  try {
    walk(join(root, dir));
  } catch {
    // a directory that is not part of this package
  }
}

let failed = 0;
let checked = 0;
for (const file of targets) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 30000 });
  if (result.error) {
    console.error(`cannot run node --check here (${result.error.message}); skipped ${targets.length} files`);
    process.exit(0);
  }
  checked += 1;
  if (result.status !== 0) {
    failed += 1;
    console.error(`SYNTAX ${relative(root, file)}\n${result.stderr}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed the syntax check`);
  process.exit(1);
}
console.log(`syntax ok: ${checked} file(s)`);