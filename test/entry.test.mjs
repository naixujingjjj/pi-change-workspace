import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { WORKSPACE_COMMAND_DESCRIPTION } from "../src/register.js";
import {
  ensurePiLink,
  makeContext,
  piPackageDir,
  readSessionJsonl,
  readText,
  removeTempDir,
  tempDir,
  writeFile,
} from "./helpers.mjs";

// The entry imports `@earendil-works/pi-coding-agent`, which Pi maps to itself
// for extensions. Here that mapping is a junction to the installed package.
const linked = ensurePiLink();
let extension = null;
let skipReason = null;
if (!piPackageDir()) {
  skipReason = "the installed @earendil-works/pi-coding-agent package was not found";
} else if (!linked) {
  skipReason =
    "this machine may not create directory links, so the entry cannot be imported here; the real Pi integration test loads it instead";
} else {
  extension = (await import("../extensions/workspace.js")).default;
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const dirs = [];

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const created of dirs) removeTempDir(created);
});

function makePi() {
  const events = new Map();
  const commands = new Map();
  return {
    on: (type, handler) => events.set(type, handler),
    registerCommand: (name, options) => commands.set(name, options),
    emit: (type, ...args) => events.get(type)?.(...args),
    commands,
  };
}

function encodedSessionsDir(agentDir, cwd) {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

describe("the extension entry", () => {
  it("wires Pi's own SessionManager and the Windows picker into the registration", () => {
    const source = readText(join(import.meta.dirname, "..", "extensions", "workspace.js"));
    assert.match(source, /import \{ SessionManager \} from "@earendil-works\/pi-coding-agent";/);
    assert.match(source, /import \{ pickFolder \} from "\.\.\/src\/picker\.js";/);
    assert.match(source, /registerWorkspaceCommands\(pi, \{ SessionManager, pickFolder \}\);/);
  });

  it("registers /workspace with Pi's API", (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal(typeof extension, "function");
    const pi = makePi();
    extension(pi);
    assert.equal(pi.commands.size, 1);
    assert.equal(pi.commands.get("workspace").description, WORKSPACE_COMMAND_DESCRIPTION);
    assert.equal(typeof pi.commands.get("workspace").handler, "function");
  });

  it("creates the target session with the real SessionManager and switches through ctx", { timeout: 60000 }, async (t) => {
    if (skipReason) return t.skip(skipReason);
    const root = tempDir("entry");
    dirs.push(root);
    const agentDir = join(root, "agent");
    const projectA = join(root, "a");
    const projectB = join(root, "b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    const sourceFile = join(encodedSessionsDir(agentDir, projectA), "source.jsonl");
    writeFile(sourceFile, `${JSON.stringify({ type: "session", version: 3, id: "source", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectA })}\n`);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const pi = makePi();
    extension(pi);
    const ctx = makeContext({
      cwd: projectA,
      sessionFile: sourceFile,
      sessionDir: encodedSessionsDir(agentDir, projectA),
      nextCwd: projectB,
      mode: "rpc",
      inputAnswer: projectB,
    });
    pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await pi.commands.get("workspace").handler("", ctx);

    assert.equal(ctx.switches.length, 1, "Pi's own switchSession is the replacement path");
    const created = ctx.switches[0].sessionPath;
    assert.notEqual(created, sourceFile);
    assert.equal(existsSync(created), true);
    const [header] = readSessionJsonl(created);
    assert.equal(header.cwd, projectB);
    assert.equal(header.type, "session");
    assert.equal(created.toLowerCase().startsWith(encodedSessionsDir(agentDir, projectB).toLowerCase()), true);
    assert.equal(ctx.autocompleteWrappers.length, 0, "RPC hosts get no autocomplete override");

    const wrappedCell = ctx.notes.map((note) => note.message).join("\n");
    assert.match(wrappedCell, /^Workspace: /);
  });
});