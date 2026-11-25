import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { WORKSPACE_COMMAND_DESCRIPTION } from "../src/register.js";
import {
  canSpawn,
  importPiApi,
  listDir,
  piPackageDir,
  readSessionJsonl,
  readText,
  removeTempDir,
  sha256,
  startPiRpc,
  tempDir,
  writeFile,
} from "./helpers.mjs";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const dirs = [];
let pi = null;
let skipReason = null;
let cliPath = null;

const ENTRY = join(import.meta.dirname, "..", "extensions", "workspace.js");
const PROBE = join(import.meta.dirname, "fixtures", "probe-extension.js");
const VETO = join(import.meta.dirname, "fixtures", "veto-extension.js");

before(async () => {
  const pkg = piPackageDir();
  if (!pkg) {
    skipReason = "the installed @earendil-works/pi-coding-agent package was not found";
    return;
  }
  cliPath = join(pkg, "dist", "bundle", "cli.js");
  if (!existsSync(cliPath)) {
    skipReason = "the installed Pi CLI bundle was not found";
    return;
  }
  if (!canSpawn()) {
    skipReason = "this process may not start child processes (sandbox); run test:integration outside it";
    return;
  }
  pi = await importPiApi();
});

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const created of dirs) removeTempDir(created);
});

function encodedSessionsDir(agentDir, cwd) {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

/** A project folder plus a real Pi session file that already has a message. */
async function scenario({ veto = false } = {}) {
  const root = tempDir(veto ? "integration-veto" : "integration");
  dirs.push(root);
  const agentDir = join(root, "agent");
  const projectA = join(root, "project a");
  const projectB = join(root, "project b 测试 & 'x'");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFile(join(projectA, "AGENTS.md"), "PROJECT A RULES\n");
  writeFile(join(projectB, "AGENTS.md"), "PROJECT B RULES 测试\n");
  writeFile(join(projectB, "relative-check.txt"), "relative read from the target workspace\n");

  process.env.PI_CODING_AGENT_DIR = agentDir;
  const manager = pi.SessionManager.create(projectA);
  manager.appendMessage({ role: "user", content: "OLD SESSION MESSAGE", timestamp: 1733234400000 });
  const fixtureFile = manager.getSessionFile();
  const fixtureId = manager.getSessionId();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

  const probeOut = join(root, "probe.json");
  const args = ["--mode", "rpc", "-ne", "-e", ENTRY, "-e", PROBE];
  if (veto) args.push("-e", VETO);
  args.push("--session", fixtureFile);

  const rpc = startPiRpc({
    cliPath,
    args,
    cwd: projectA,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_WORKSPACE_PROBE_OUT: probeOut,
      PI_WORKSPACE_VETO: veto ? "1" : "0",
    },
  });

  let stateCounter = 0;
  const state = async () => {
    stateCounter += 1;
    const id = `state-${stateCounter}`;
    rpc.send({ id, type: "get_state" });
    const response = await rpc.waitResponse(id, { timeoutMs: 30000 });
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };

  const prompt = async (message, id) => {
    rpc.send({ id, type: "prompt", message });
    const response = await rpc.waitResponse(id, { timeoutMs: 30000 });
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };

  /** Run one `/workspace` step: the extension asks for a path over RPC. */
  const workspace = async (id, answer) => {
    await prompt("/workspace", id);
    const request = await rpc.waitUiRequest("input", { timeoutMs: 30000 });
    rpc.respond(request.id, "value" in answer ? { value: answer.value } : { cancelled: true });
    return request;
  };

  return { root, agentDir, projectA, projectB, fixtureFile, fixtureId, probeOut, rpc, state, prompt, workspace };
}

describe("real Pi 1.6 session replacement", () => {
  it("switches the same process into a fresh session for the chosen folder", { timeout: 180000 }, async (t) => {
    if (skipReason) return t.skip(skipReason);
    const world = await scenario();
    const { rpc } = world;
    try {
      const initial = await world.state();
      assert.equal(initial.sessionId, world.fixtureId);
      assert.equal(initial.messageCount, 1);

      // The command is registered once, and only once.
      rpc.send({ id: "cmds", type: "get_commands" });
      const commands = await rpc.waitResponse("cmds", { timeoutMs: 30000 });
      const workspaceCommands = (commands.data.commands || []).filter((command) => command.name === "workspace");
      assert.equal(workspaceCommands.length, 1);
      assert.equal(workspaceCommands[0].description, WORKSPACE_COMMAND_DESCRIPTION);

      // Cancel: nothing happens.
      await world.workspace("cancel", { cancelled: true });
      await rpc.waitNotify("Canceled", { timeoutMs: 30000 });
      assert.equal((await world.state()).sessionId, world.fixtureId);

      // Same folder, different case and a trailing separator: a no-op.
      await world.workspace("same", { value: `${world.projectA.toUpperCase()}\\` });
      await rpc.waitNotify("Already in", { timeoutMs: 30000 });
      assert.equal((await world.state()).sessionId, world.fixtureId);

      // A path that is not a folder is a short error, not a dialog or a switch.
      await world.workspace("invalid", { value: join(world.root, "missing folder") });
      await rpc.waitNotify("Folder not found:", { timeoutMs: 30000 });
      assert.equal((await world.state()).sessionId, world.fixtureId);

      // Pi itself writes its setup entries (model/thinking) into an opened
      // session; once that has settled, the switch must not touch the file.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const fixtureHash = sha256(world.fixtureFile);
      const fixtureBefore = readSessionJsonl(world.fixtureFile);
      assert.equal(sha256(world.fixtureFile), fixtureHash);

      // The real switch.
      await world.workspace("switch", { value: world.projectB });
      await rpc.waitNotify("Workspace: ", { timeoutMs: 60000 });
      const switched = await rpc.waitUntil(
        async () => {
          const state = await world.state();
          return state.sessionFile !== world.fixtureFile ? state : null;
        },
        { timeoutMs: 60000, label: "switched session state" },
      );
      assert.notEqual(switched.sessionId, world.fixtureId);
      assert.equal(switched.messageCount, 0, "the target session starts blank");

      const realB = realpathSync.native(world.projectB);
      assert.equal(switched.sessionFile.toLowerCase().startsWith(encodedSessionsDir(world.agentDir, realB).toLowerCase()), true, switched.sessionFile);
      const header = readSessionJsonl(switched.sessionFile)[0];
      assert.equal(header.type, "session");
      assert.equal(header.cwd, realB, "the new session header names the target workspace");

      const targetEntries = readSessionJsonl(switched.sessionFile);
      assert.equal(targetEntries.some((entry) => entry.type === "message"), false, "no old messages are copied");
      assert.equal(readText(switched.sessionFile).includes("OLD SESSION MESSAGE"), false);

      // The old conversation is untouched and still resumable.
      assert.equal(sha256(world.fixtureFile), fixtureHash);
      assert.deepEqual(readSessionJsonl(world.fixtureFile), fixtureBefore);
      assert.equal(readSessionJsonl(world.fixtureFile).filter((entry) => entry.type === "message").length, 1);

      // Pi rebuilt the runtime: cwd, context files, and a real built-in tool
      // reading a relative path all point at the target.
      await world.prompt("/probe", "probe");
      await rpc.waitFor(() => existsSync(world.probeOut), { timeoutMs: 60000, label: "probe output" });
      const probe = JSON.parse(readText(world.probeOut));
      assert.equal(probe.cwd, realB);
      assert.equal(probe.promptCwd, realB);
      assert.equal(probe.sessionFile, switched.sessionFile);
      assert.equal(
        probe.contextFiles.some((file) => file.toLowerCase() === join(realB, "AGENTS.md").toLowerCase()),
        true,
        JSON.stringify(probe.contextFiles),
      );
      assert.equal(
        probe.contextFiles.some((file) => file.toLowerCase() === join(realpathSync.native(world.projectA), "AGENTS.md").toLowerCase()),
        false,
        "the previous project context must not linger",
      );
      assert.match(probe.read.text, /PROJECT B RULES/);
      assert.equal(probe.read.isError, false);
      assert.equal(probe.entryTypes.includes("message"), false);

      const exit = await rpc.close();
      assert.equal(exit.code, 0, exit.stderr);
    } finally {
      await rpc.close();
    }
  });

  it("leaves the session and no stray file behind when the switch is vetoed", { timeout: 180000 }, async (t) => {
    if (skipReason) return t.skip(skipReason);
    const world = await scenario({ veto: true });
    const { rpc } = world;
    try {
      const initial = await world.state();
      assert.equal(initial.sessionId, world.fixtureId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const fixtureHash = sha256(world.fixtureFile);

      await world.workspace("veto", { value: world.projectB });
      await rpc.waitNotify("Workspace switch canceled.", { timeoutMs: 60000 });
      const after = await world.state();
      assert.equal(after.sessionId, world.fixtureId, "the source session stays active");
      assert.equal(sha256(world.fixtureFile), fixtureHash);

      const realB = realpathSync.native(world.projectB);
      const targetDir = encodedSessionsDir(world.agentDir, realB);
      const leftovers = listDir(targetDir).filter((name) => name.endsWith(".jsonl"));
      assert.deepEqual(leftovers, [], "the unused header-only session file is removed");

      const exit = await rpc.close();
      assert.equal(exit.code, 0, exit.stderr);
    } finally {
      await rpc.close();
    }
  });
});