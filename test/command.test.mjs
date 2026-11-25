import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { removeOwnedHeaderFile } from "../src/session-target.js";
import { canonicalizeDirectory, samePath } from "../src/target-path.js";
import { RESULT_CODES, resetWorkspaceCommandState, runWorkspaceCommand } from "../src/command.js";
import { makeContext, readText, removeTempDir, sha256, tempDir, writeFile } from "./helpers.mjs";

const dirs = [];

after(() => {
  for (const created of dirs) removeTempDir(created);
  resetWorkspaceCommandState();
});

/**
 * One hermetic command world: a source session, a real target directory, a real
 * header-only "planned" session file, and injectable collaborators. The real
 * `canonicalizeDirectory`, `samePath` and `removeOwnedHeaderFile` are used, so
 * the checks are the ones the extension performs.
 */
function setup(overrides = {}) {
  const root = tempDir("command");
  dirs.push(root);
  const currentCwd = join(root, "current workspace");
  const targetCwd = join(root, "target 测试 & 'x'");
  mkdirSync(currentCwd, { recursive: true });
  mkdirSync(targetCwd, { recursive: true });

  const sourceFile = join(root, "source-session.jsonl");
  const sourceHeader = { type: "session", version: 3, id: "source-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: currentCwd };
  const sourceMessage = { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "OLD MESSAGE", timestamp: 1 } };
  writeFile(sourceFile, `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`);

  const planFile = join(root, "plan-session.jsonl");
  const planHeader = { type: "session", version: 3, id: "plan-id", timestamp: "2026-01-01T00:00:02.000Z", cwd: targetCwd };
  const plan = { ok: true, code: null, sessionFile: planFile, header: planHeader, sessionId: "plan-id", storage: "target-default", targetCwd };
  const calls = { pickFolder: 0, plan: 0, setWorkspacePath: [] };
  const planned = [];

  const deps = {
    pickFolder: async () => {
      calls.pickFolder += 1;
      return { ok: true, path: targetCwd };
    },
    canonicalize: canonicalizeDirectory,
    samePath,
    planTargetSession: () => {
      calls.plan += 1;
      writeFile(planFile, `${JSON.stringify(planHeader)}\n`);
      planned.push(planFile);
      return plan;
    },
    removeOwnedHeaderFile,
    setWorkspacePath: (value) => calls.setWorkspacePath.push(value),
    ...overrides.deps,
  };

  const ctx = makeContext({
    cwd: currentCwd,
    sessionFile: sourceFile,
    sessionDir: join(root, "source-sessions"),
    nextCwd: targetCwd,
    ...overrides.ctx,
  });

  return { root, currentCwd, targetCwd, sourceFile, planFile, planHeader, plan, deps, ctx, calls };
}

function notesText(ctx) {
  return ctx.notes.map((note) => note.message).join("\n");
}

describe("runWorkspaceCommand", () => {
  it("switches to the picked folder and reports it against the replacement session", async () => {
    const world = setup();
    const sourceHash = sha256(world.sourceFile);
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });

    assert.equal(result.ok, true, result.message);
    assert.equal(result.code, RESULT_CODES.OK);
    assert.equal(result.path, canonicalizeDirectory(world.targetCwd).path);
    assert.equal(world.ctx.switches.length, 1);
    assert.equal(world.ctx.switches[0].sessionPath, world.planFile);
    assert.deepEqual(world.calls.setWorkspacePath, [canonicalizeDirectory(world.targetCwd).path]);
    assert.match(notesText(world.ctx), /^Workspace: /);
    assert.equal(sha256(world.sourceFile), sourceHash, "the source session must not change");
    assert.equal(existsSync(world.planFile), true, "a successful switch keeps the new session file");
  });

  it("is a silent no-op when the dialog is cancelled", async () => {
    const world = setup({ deps: { pickFolder: async () => ({ ok: false, cancelled: true, message: "Canceled. Workspace unchanged." }) } });
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.CANCELLED);
    assert.equal(world.ctx.switches.length, 0);
    assert.equal(world.calls.plan, 0);
    assert.equal(notesText(world.ctx), "Canceled. Workspace unchanged.");
  });

  it("is a no-op for the same directory, including case and trailing separators", async () => {
    const world = setup();
    for (const same of [world.currentCwd, world.currentCwd.toUpperCase(), `${world.currentCwd}\\`]) {
      const result = await runWorkspaceCommand(world.ctx, {
        args: "",
        deps: { ...world.deps, pickFolder: async () => ({ ok: true, path: same }) },
      });
      assert.equal(result.code, RESULT_CODES.SAME);
      assert.match(result.message, /^Already in /);
      assert.equal(world.ctx.switches.length, 0);
    }
    assert.equal(world.calls.plan, 0);
  });

  it("falls back to a typed path when the dialog is unavailable", async () => {
    const world = setup({
      deps: {
        pickFolder: async () => ({
          ok: false,
          available: false,
          cancelled: false,
          code: "PICKER_UNAVAILABLE",
          message: "The folder dialog is unavailable (no WinForms). Type the folder path.",
        }),
      },
    });
    world.ctx.inputAnswer = world.targetCwd;
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.ok, true, result.message);
    assert.equal(world.ctx.prompts.length, 1);
    assert.match(world.ctx.notes[0].message, /^The folder dialog is unavailable/);
    assert.equal(world.ctx.notes[0].level, "info");
  });

  it("stays put when the typed path is also cancelled", async () => {
    const world = setup({
      deps: {
        pickFolder: async () => ({ ok: false, available: true, cancelled: false, message: "The folder dialog failed. Workspace unchanged." }),
      },
      ctx: { inputAnswer: undefined },
    });
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.CANCELLED);
    assert.equal(world.ctx.switches.length, 0);
    assert.equal(world.ctx.notes.at(-1).message, "Canceled. Workspace unchanged.");
  });

  it("rejects a path that is not a folder with one short error", async () => {
    const world = setup({ deps: { pickFolder: null } });
    world.ctx.inputAnswer = join(world.root, "missing");
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.INVALID);
    assert.match(result.message, /^Folder not found: /);
    assert.equal(world.ctx.notes.at(-1).level, "error");
    assert.equal(world.ctx.switches.length, 0);
  });

  it("asks before aborting a running response, and honours a refusal", async () => {
    const world = setup({ ctx: { idle: false, confirmAnswer: false } });
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.CANCELLED);
    assert.equal(world.ctx.confirmations.length, 1);
    assert.match(world.ctx.confirmations[0].message, /current response stops/);
    assert.equal(world.ctx.switches.length, 0);
  });

  it("asks about queued input too, and switches when confirmed", async () => {
    const world = setup({ ctx: { idle: true, pending: true, confirmAnswer: true } });
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.ok, true, result.message);
    assert.equal(world.ctx.confirmations.length, 1);
    assert.equal(world.ctx.switches.length, 1);
  });

  it("refuses to switch while busy when no confirmation is possible", async () => {
    const world = setup({ ctx: { idle: false } });
    delete world.ctx.ui.confirm;
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.UNAVAILABLE);
    assert.match(result.message, /while Pi is busy/);
    assert.equal(world.ctx.switches.length, 0);
  });

  it("drops the new session file when another extension vetoes the switch", async () => {
    const world = setup({ ctx: { switchVeto: true } });
    const sourceHash = sha256(world.sourceFile);
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.VETOED);
    assert.equal(result.cleanup.removed, true);
    assert.equal(existsSync(world.planFile), false);
    assert.equal(sha256(world.sourceFile), sourceHash);
    assert.match(notesText(world.ctx), /Workspace switch canceled\./);
  });

  it("reports a failed switch and removes its unused session file", async () => {
    const world = setup({ ctx: { switchThrows: Object.assign(new Error("EPERM: denied\nat somewhere"), {}) } });
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.FAILED);
    assert.equal(result.message, "Could not switch workspace: EPERM: denied");
    assert.equal(result.cleanup.removed, true);
    assert.equal(existsSync(world.planFile), false);
    assert.equal(world.ctx.notes.at(-1).level, "error");
  });

  it("leaves the file alone when a failure makes the outcome uncertain", async () => {
    const world = setup({
      ctx: {
        switchImpl: async () => {
          // Pi invalidates the old context the moment the runtime is replaced.
          Object.defineProperty(world.ctx, "sessionManager", {
            configurable: true,
            get() {
              throw new Error("This extension ctx is stale after session replacement.");
            },
          });
          throw new Error("rebind failed");
        },
      },
    });
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.FAILED);
    assert.equal(result.cleanup.left, true);
    assert.equal(existsSync(world.planFile), true);
    assert.match(notesText(world.ctx), /Left unused session file: /);
  });

  it("refuses with --no-session, before asking for a folder", async () => {
    const world = setup({ ctx: { sessionFile: undefined } });
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.NO_SESSION);
    assert.match(result.message, /--no-session/);
    assert.equal(world.calls.pickFolder, 0);
    assert.equal(world.ctx.switches.length, 0);
  });

  it("uses the typed path in a non-interactive host instead of a GUI dialog", async () => {
    let dialogOpened = false;
    const world = setup({
      ctx: { mode: "rpc" },
      deps: {
        pickFolder: async () => {
          dialogOpened = true;
          return { ok: true, path: worldTarget() };
        },
      },
    });
    function worldTarget() {
      return world.targetCwd;
    }
    world.ctx.inputAnswer = world.targetCwd;
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.ok, true, result.message);
    assert.equal(dialogOpened, false);
    assert.equal(world.ctx.prompts.length, 1);
  });

  it("rejects arguments, because there are no extra command modes", async () => {
    const world = setup();
    const result = await runWorkspaceCommand(world.ctx, { args: " F:\\elsewhere", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.INVALID);
    assert.equal(result.message, "Usage: /workspace takes no arguments.");
    assert.equal(world.calls.pickFolder, 0);
  });

  it("surfaces a planning failure with its own code", async () => {
    const world = setup({
      deps: {
        planTargetSession: () => ({ ok: false, code: "NO_SESSION", message: "Workspace switching needs saved sessions. Start Pi without --no-session." }),
      },
    });
    const result = await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(result.code, RESULT_CODES.NO_SESSION);
    assert.equal(world.ctx.switches.length, 0);
  });

  it("allows only one invocation at a time", async () => {
    const world = setup();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const slow = { ...world.deps, pickFolder: async () => { await gate; return { ok: true, path: world.targetCwd }; } };
    const first = runWorkspaceCommand(world.ctx, { args: "", deps: slow });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await runWorkspaceCommand(world.ctx, { args: "", deps: slow });
    assert.equal(second.code, RESULT_CODES.BUSY);
    assert.equal(world.calls.plan, 0);
    release();
    const firstResult = await first;
    assert.equal(firstResult.ok, true, firstResult.message);
    assert.equal(world.ctx.switches.length, 1);
  });

  it("never touches the source session on any failure path", async () => {
    const world = setup({ ctx: { switchVeto: true } });
    const before = readText(world.sourceFile);
    await runWorkspaceCommand(world.ctx, { args: "", deps: world.deps });
    assert.equal(readText(world.sourceFile), before);
  });
});