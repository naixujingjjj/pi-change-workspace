import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createWorkspaceRowProvider, patchWorkspaceRow } from "../src/autocomplete.js";
import { importPiTui, piTuiDir, removeTempDir, tempDir } from "./helpers.mjs";

let CombinedAutocompleteProvider = null;
let skipReason = null;
const dirs = [];
let workspaceDir = null;

before(async () => {
  if (!piTuiDir()) {
    skipReason = "the installed @earendil-works/pi-tui package was not found";
    return;
  }
  const tui = await importPiTui();
  CombinedAutocompleteProvider = tui.CombinedAutocompleteProvider;
  workspaceDir = tempDir("autocomplete");
  dirs.push(workspaceDir);
});

after(() => {
  for (const created of dirs) removeTempDir(created);
});

/**
 * The command list exactly as Pi 1.6 hands it to the provider for an extension
 * command: the name, and the description already prefixed with the origin tag
 * by `prefixAutocompleteDescription` (here `[u]` for a user-scope extension).
 */
function baseCommands() {
  return [
    { name: "workspace", description: "[u] Switch workspace: choose a folder and continue in a fresh session for it" },
    { name: "workspace-extra", description: "[u] a different command that only shares the prefix" },
    { name: "help", description: "Show help" },
  ];
}

async function complete(provider, lines, cursorCol) {
  return provider.getSuggestions(lines, 0, cursorCol, { signal: new AbortController().signal });
}

function item(suggestions, name) {
  return suggestions.items.find((entry) => entry.value === name);
}

describe("the real Pi 1.6 autocomplete provider", () => {
  it("tags the /workspace row before the extension wraps it", (t) => {
    if (skipReason) return t.skip(skipReason);
    const provider = new CombinedAutocompleteProvider(baseCommands(), workspaceDir);
    return complete(provider, ["/"], 1).then((suggestions) => {
      const row = item(suggestions, "workspace");
      assert.ok(row, "the /workspace row must be present");
      assert.equal(row.label, "workspace");
      assert.match(row.description, /^\[u\] /, "Pi prefixes extension descriptions with its origin tag");
      assert.equal(item(suggestions, "workspace-extra").description, "[u] a different command that only shares the prefix");
    });
  });

  it("shows only the live workspace path after wrapping, and leaves every other row untouched", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const base = new CombinedAutocompleteProvider(baseCommands(), workspaceDir);
    const before = await complete(base, ["/"], 1);
    const beforeWorkspace = item(before, "workspace").description;
    const beforeExtra = item(before, "workspace-extra");
    const beforeHelp = item(before, "help");

    const state = { path: "F:\\dsh" };
    const wrapped = createWorkspaceRowProvider(() => state.path)(base);
    const after = await complete(wrapped, ["/"], 1);
    const afterWorkspace = item(after, "workspace");

    assert.equal(afterWorkspace.description, "F:\\dsh", "the row is the absolute path and nothing else");
    assert.equal(/\[u\]/.test(afterWorkspace.description), false, "no origin tag on this row");
    assert.equal(afterWorkspace.value, "workspace");
    assert.equal(afterWorkspace.label, "workspace");
    assert.equal(item(after, "workspace-extra").description, beforeExtra.description, "/workspace-* rows stay untouched");
    assert.deepEqual(item(after, "help"), beforeHelp);
    assert.equal(after.items.length, before.items.length);
    assert.equal(after.prefix, before.prefix);

    // Pi's base provider still returns the tagged row: the wrapper never mutated it.
    const again = await complete(base, ["/"], 1);
    assert.equal(item(again, "workspace").description, beforeWorkspace);

    // A replacement refreshes the row on the next completion.
    state.path = "F:\\dsh\\other project";
    const refreshed = await complete(wrapped, ["/"], 1);
    assert.equal(item(refreshed, "workspace").description, "F:\\dsh\\other project");
    assert.equal(item(refreshed, "workspace-extra").description, beforeExtra.description);
  });

  it("does not confuse /workspace with commands that merely start the same way", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const base = new CombinedAutocompleteProvider(baseCommands(), workspaceDir);
    const wrapped = createWorkspaceRowProvider(() => "F:\\dsh")(base);
    const suggestions = await complete(wrapped, ["/workspace-ext"], 14);
    assert.ok(item(suggestions, "workspace-extra"), "the look-alike row is still offered");
    assert.equal(item(suggestions, "workspace-extra").description, "[u] a different command that only shares the prefix");
    if (item(suggestions, "workspace")) {
      assert.equal(item(suggestions, "workspace").description, "F:\\dsh");
    }
  });

  it("preserves the provider surface Pi relies on", (t) => {
    if (skipReason) return t.skip(skipReason);
    const base = new CombinedAutocompleteProvider(baseCommands(), workspaceDir);
    const wrapped = createWorkspaceRowProvider(() => "F:\\dsh")(base);
    assert.equal(typeof wrapped.getSuggestions, "function");
    assert.equal(typeof wrapped.applyCompletion, "function");
    assert.equal(wrapped.triggerCharacters, base.triggerCharacters);
    assert.equal(typeof wrapped.shouldTriggerFileCompletion, typeof base.shouldTriggerFileCompletion);
    const applied = wrapped.applyCompletion(["/wor"], 0, 4, { value: "workspace", label: "workspace" }, "/wor");
    assert.deepEqual(applied, base.applyCompletion(["/wor"], 0, 4, { value: "workspace", label: "workspace" }, "/wor"));
  });
});

describe("patchWorkspaceRow", () => {
  it("requires the exact workspace row", () => {
    const suggestions = {
      prefix: "/",
      items: [
        { value: "workspace", label: "workspace", description: "[u] old" },
        { value: "workspace-extra", label: "workspace-extra", description: "[u] keep" },
        { value: "workspace", label: "workspace-extra", description: "[u] keep too" },
        { value: "workspace", label: "workspace", description: "[u] second exact row" },
        null,
        "not an item",
      ],
    };
    const patched = patchWorkspaceRow(suggestions, "F:\\dsh");
    assert.equal(patched.items[0].description, "F:\\dsh");
    assert.equal(patched.items[1].description, "[u] keep");
    assert.equal(patched.items[2].description, "[u] keep too");
    assert.equal(patched.items[3].description, "F:\\dsh");
    assert.equal(patched.items[4], null);
    assert.equal(patched.items[5], "not an item");
    assert.equal(suggestions.items[0].description, "[u] old", "the input is never mutated");
  });

  it("leaves argument completions alone, even when a value happens to be named workspace", () => {
    const suggestions = {
      prefix: "/other --",
      items: [{ value: "workspace", label: "workspace", description: "an argument value" }],
    };
    assert.equal(patchWorkspaceRow(suggestions, "F:\\dsh"), suggestions);
  });

  it("passes through nothing, empty descriptions and malformed results", () => {
    assert.equal(patchWorkspaceRow(null, "F:\\dsh"), null);
    const suggestions = { prefix: "/", items: [{ value: "workspace", label: "workspace", description: "x" }] };
    assert.equal(patchWorkspaceRow(suggestions, ""), suggestions);
    assert.equal(patchWorkspaceRow(suggestions, undefined), suggestions);
    assert.equal(patchWorkspaceRow({ prefix: "/" }, "F:\\dsh").prefix, "/");
  });

  it("reports no change when the row already shows the path", () => {
    const suggestions = { prefix: "/", items: [{ value: "workspace", label: "workspace", description: "F:\\dsh" }] };
    assert.equal(patchWorkspaceRow(suggestions, "F:\\dsh"), suggestions);
  });
});

describe("createWorkspaceRowProvider", () => {
  it("passes the provider through when it cannot be wrapped", () => {
    assert.equal(createWorkspaceRowProvider(() => "F:\\dsh")(null), null);
    const notAProvider = { getSuggestions: "nope" };
    assert.equal(createWorkspaceRowProvider(() => "F:\\dsh")(notAProvider), notAProvider);
  });

  it("passes null suggestions through and survives a throwing path source", async () => {
    const base = {
      getSuggestions: async () => null,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    };
    const wrapped = createWorkspaceRowProvider(() => {
      throw new Error("no path");
    })(base);
    assert.equal(await wrapped.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal }), null);
    const throwingSource = createWorkspaceRowProvider(() => {
      throw new Error("no path");
    })({
      getSuggestions: async () => ({ prefix: "/", items: [{ value: "workspace", label: "workspace", description: "x" }] }),
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    });
    const unchanged = await throwingSource.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
    assert.equal(unchanged.items[0].description, "x");
  });
});