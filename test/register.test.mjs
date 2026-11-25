import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { WORKSPACE_COMMAND_DESCRIPTION, registerWorkspaceCommands } from "../src/register.js";
import { removeOwnedHeaderFile } from "../src/session-target.js";
import { canonicalizeDirectory, samePath } from "../src/target-path.js";
import { makeContext, removeTempDir, tempDir, writeFile } from "./helpers.mjs";

const dirs = [];
function dir(label) {
  const created = tempDir(label);
  dirs.push(created);
  return created;
}

after(() => {
  for (const created of dirs) removeTempDir(created);
});

/** The smallest `pi` API object the wiring uses. */
function makePi() {
  const events = new Map();
  const commands = new Map();
  return {
    on(type, handler) {
      events.set(type, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    emit(type, ...args) {
      return events.get(type)?.(...args);
    },
    commands,
  };
}

function providerItems(description) {
  return { prefix: "/", items: [{ value: "workspace", label: "workspace", description }] };
}

function baseProvider(description) {
  return {
    getSuggestions: async () => providerItems(description),
    applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }),
    triggerCharacters: [],
  };
}

describe("registerWorkspaceCommands", () => {
  it("registers exactly one /workspace command with the static description", () => {
    const pi = makePi();
    registerWorkspaceCommands(pi, {});
    assert.equal(pi.commands.size, 1);
    const command = pi.commands.get("workspace");
    assert.ok(command);
    assert.equal(command.description, WORKSPACE_COMMAND_DESCRIPTION);
    assert.equal(typeof command.handler, "function");
    assert.equal(pi.commands.has("workspace-extra"), false);
  });

  it("installs the autocomplete override at session_start and tracks the cwd", async () => {
    const pi = makePi();
    const state = registerWorkspaceCommands(pi, {});
    const ctx = makeContext({ cwd: "F:\\dsh\\first" });
    ctx.ui.addAutocompleteProvider = (factory) => ctx.autocompleteWrappers.push(factory);
    pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    assert.equal(state.getWorkspacePath(), "F:\\dsh\\first");
    assert.equal(ctx.autocompleteWrappers.length, 1);
    const wrapped = ctx.autocompleteWrappers[0](baseProvider("[u] " + WORKSPACE_COMMAND_DESCRIPTION));
    const suggestions = await wrapped.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
    assert.equal(suggestions.items[0].description, "F:\\dsh\\first");
  });

  it("does not touch autocomplete outside the TUI", () => {
    const pi = makePi();
    registerWorkspaceCommands(pi, {});
    const ctx = makeContext({ cwd: "F:\\dsh\\rpc", mode: "rpc" });
    pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(ctx.autocompleteWrappers.length, 0);
  });

  it("survives a host without addAutocompleteProvider or a throwing one", () => {
    const pi = makePi();
    registerWorkspaceCommands(pi, {});
    const bare = makeContext({ cwd: "F:\\dsh" });
    delete bare.ui.addAutocompleteProvider;
    pi.emit("session_start", { type: "session_start", reason: "startup" }, bare);

    const hostile = makeContext({ cwd: "F:\\dsh" });
    hostile.ui.addAutocompleteProvider = () => {
      throw new Error("no provider here");
    };
    pi.emit("session_start", { type: "session_start", reason: "startup" }, hostile);
  });

  it("clears the tracked path when the session reports no cwd", () => {
    const pi = makePi();
    const state = registerWorkspaceCommands(pi, {});
    state.setWorkspacePath("F:\\dsh\\stale");
    const ctx = makeContext({ cwd: "" });
    ctx.sessionManager.getCwd = () => "";
    pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(state.getWorkspacePath(), "");
  });

  it("refreshes the autocomplete row after a successful workspace replacement", async () => {
    const root = dir("register");
    const projectA = join(root, "a");
    const projectB = join(root, "b 测试");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    const sourceFile = join(root, "source.jsonl");
    writeFile(sourceFile, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectA })}\n`);
    const planFile = join(root, "plan.jsonl");
    const planHeader = { type: "session", version: 3, id: "p", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectB };

    const pi = makePi();
    const state = registerWorkspaceCommands(pi, {
      pickFolder: async () => ({ ok: true, path: projectB }),
      canonicalize: canonicalizeDirectory,
      samePath,
      planTargetSession: () => {
        writeFile(planFile, `${JSON.stringify(planHeader)}\n`);
        return { ok: true, sessionFile: planFile, header: planHeader, sessionId: "p", storage: "target-default" };
      },
      removeOwnedHeaderFile,
    });

    const ctx = makeContext({ cwd: projectA, sessionFile: sourceFile, sessionDir: join(root, "sessions"), nextCwd: projectB });
    pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const wrapped = ctx.autocompleteWrappers[0](baseProvider("[u] " + WORKSPACE_COMMAND_DESCRIPTION));

    const before = await wrapped.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
    assert.equal(before.items[0].description, projectA);

    await pi.commands.get("workspace").handler("", ctx);
    assert.equal(ctx.switches.length, 1);
    assert.equal(state.getWorkspacePath(), canonicalizeDirectory(projectB).path);

    const after = await wrapped.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
    assert.equal(after.items[0].description, canonicalizeDirectory(projectB).path);
  });
});