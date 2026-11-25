import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  PICKER_INPUT_NAME,
  PICKER_RESULT_NAME,
  PICKER_SCRIPT,
  buildPickerInput,
  interpretPickerRun,
  isUsablePickedPath,
  pickFolder,
  readPickerPayload,
  shellCandidates,
} from "../src/picker.js";
import { canSpawn, listDir, removeTempDir, tempDir, writeFile } from "./helpers.mjs";

const dirs = [];
function dir(label) {
  const created = tempDir(label);
  dirs.push(created);
  return created;
}

after(() => {
  for (const created of dirs) removeTempDir(created);
});

/**
 * A stand-in for `spawn` that runs `behaviour` on the next tick and then closes
 * the "process". It is what lets the picker's real control flow (temp dirs,
 * fallback shells, result parsing, cleanup) run without opening any window.
 */
function fakeSpawn(behaviour) {
  const calls = [];
  const impl = (exe, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    const scriptPath = args[args.length - 1];
    const dir = dirname(scriptPath);
    calls.push({ exe, args, options, dir });
    setImmediate(() => {
      try {
        behaviour({ exe, args, options, dir, child });
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  };
  return { impl, calls };
}

function writeResult(dir, payload) {
  writeFileSync(join(dir, PICKER_RESULT_NAME), JSON.stringify(payload), "utf8");
}

describe("picker input is data, never code", () => {
  it("round-trips spaces, quotes, dollars, percent and Unicode", () => {
    const initial = "F:\\dsh\\a b\\'q' $d %p 测试";
    const description = 'Pick "the" folder & more';
    const raw = buildPickerInput({ initial, description });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.initial, initial);
    assert.equal(parsed.description, description);
    const path = join(dir("input"), PICKER_INPUT_NAME);
    writeFile(path, raw);
    assert.deepEqual(readPickerPayload(path), { initial, description });
  });

  it("never interpolates a path into the PowerShell source", () => {
    assert.equal(PICKER_SCRIPT.includes("$settings.initial"), true);
    const sample = "F:\\dsh\\a b\\'q' $d %p 测试";
    for (const needle of [sample, "测试", "a b\\'q'", "%p 测试"]) {
      assert.equal(PICKER_SCRIPT.includes(needle), false, `script unexpectedly contains ${needle}`);
    }
    assert.equal(/[^\x00-\x7F]/.test(PICKER_SCRIPT), false, "the script must stay ASCII for Windows PowerShell 5.1");
  });

  it("reads BOM-less UTF-8 results and rejects junk", () => {
    const root = dir("payload");
    const file = join(root, PICKER_RESULT_NAME);
    writeFileSync(file, `\uFEFF${JSON.stringify({ cancelled: false, path: "F:\\目标 目录" })}`, "utf8");
    assert.deepEqual(readPickerPayload(file), { cancelled: false, path: "F:\\目标 目录" });
    writeFileSync(file, "not json", "utf8");
    assert.equal(readPickerPayload(file), null);
    writeFileSync(file, "[]", "utf8");
    assert.equal(readPickerPayload(file), null);
  });

  it("accepts only absolute printable paths", () => {
    assert.equal(isUsablePickedPath("F:\\dsh"), true);
    assert.equal(isUsablePickedPath("  F:\\dsh  "), false);
    assert.equal(isUsablePickedPath("relative\\dir"), false);
    assert.equal(isUsablePickedPath(""), false);
    assert.equal(isUsablePickedPath("F:\\a\u0000b"), false);
    assert.equal(isUsablePickedPath(null), false);
  });
});

describe("interpretPickerRun", () => {
  it("maps a cancel to a cancel, not to an error", () => {
    const verdict = interpretPickerRun({ payload: { cancelled: true }, exitCode: 0 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.cancelled, true);
    assert.equal(verdict.code, "PICKER_CANCELLED");
    assert.equal(verdict.next, "return");
  });

  it("maps a picked path, including Unicode, to success", () => {
    const path = "F:\\work\\测试 目录 & 'x'\u00a0";
    const verdict = interpretPickerRun({ payload: { cancelled: false, path }, exitCode: 0 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.path, path);
    assert.equal(verdict.cancelled, false);
  });

  it("reports an invalid returned path without using it", () => {
    const verdict = interpretPickerRun({ payload: { cancelled: false, path: "relative" }, exitCode: 0 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "PICKER_INVALID_PATH");
    assert.match(verdict.message, /Workspace unchanged\.$/);
  });

  it("distinguishes a missing WinForms (unavailable) from a dialog failure", () => {
    const unavailable = interpretPickerRun({ payload: { error: "no forms", stage: "assembly" }, exitCode: 3 });
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.code, "PICKER_UNAVAILABLE");
    const failed = interpretPickerRun({ payload: { error: "boom", stage: "dialog" }, exitCode: 4 });
    assert.equal(failed.available, true);
    assert.equal(failed.code, "PICKER_DIALOG_FAILED");
    assert.match(failed.message, /^The folder dialog failed \(boom\)/);
  });

  it("reports a non-zero exit and a missing result as errors", () => {
    const exit = interpretPickerRun({ payload: null, exitCode: 9, stderr: "bad option\nsecond line" });
    assert.equal(exit.code, "PICKER_EXIT_CODE");
    assert.match(exit.message, /exit code 9\). bad option\. Workspace unchanged\./);
    const none = interpretPickerRun({ payload: null, exitCode: 0 });
    assert.equal(none.code, "PICKER_NO_RESULT");
  });

  it("reports a killed dialog as a timeout, never as a cancel", () => {
    const verdict = interpretPickerRun({ payload: null, killed: true });
    assert.equal(verdict.cancelled, false);
    assert.equal(verdict.code, "PICKER_TIMEOUT");
  });

  it("asks for the next shell only when the shell itself was missing", () => {
    const missing = interpretPickerRun({ payload: null, exitCode: 1, stderr: "pwsh.exe : The term 'pwsh.exe' is not recognized" });
    assert.equal(missing.next, "shell");
    const real = interpretPickerRun({ payload: { cancelled: true }, exitCode: 0, stderr: "not recognized" });
    assert.equal(real.next, "return");
  });
});

describe("shellCandidates", () => {
  it("tries PowerShell 7 before Windows PowerShell and honours the override", () => {
    assert.deepEqual(shellCandidates({}, ""), ["pwsh.exe", "powershell.exe"]);
    assert.deepEqual(shellCandidates({ PI_CHANGE_WORKSPACE_PICKER_SHELL: "C:\\ps\\pwsh.exe" }, ""), ["C:\\ps\\pwsh.exe"]);
    assert.deepEqual(shellCandidates({}, "custom.exe"), ["custom.exe"]);
  });
});

describe("pickFolder", () => {
  const windows = process.platform === "win32";

  it("is unavailable off Windows, without trying to start anything", async () => {
    const verdict = await pickFolder({ platform: "linux" });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.available, false);
    assert.equal(verdict.code, "PICKER_UNAVAILABLE");
  });

  it("writes the starting directory as data, returns the pick and cleans up", { skip: !windows }, async () => {
    const root = dir("happy");
    const selected = dir("selected 目录 & 'x'");
    let seenInput = null;
    const fake = fakeSpawn(({ dir: scriptDir, child }) => {
      seenInput = readPickerPayload(join(scriptDir, PICKER_INPUT_NAME));
      writeResult(scriptDir, { cancelled: false, path: selected });
      child.emit("close", 0, null);
    });
    const verdict = await pickFolder({ platform: "win32", initialDir: "F:\\start 目录", tempRoot: root, spawnImpl: fake.impl });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.path, selected);
    assert.deepEqual(seenInput, { initial: "F:\\start 目录", description: "Select the workspace folder for Pi." });
    assert.equal(fake.calls[0].exe, "pwsh.exe");
    assert.deepEqual(fake.calls[0].args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"]);
    assert.equal(listDir(root).length, 0, "the temp dialog directory must be removed");
  });

  it("treats a cancel as a cancel", { skip: !windows }, async () => {
    const root = dir("cancel");
    const fake = fakeSpawn(({ dir: scriptDir, child }) => {
      writeResult(scriptDir, { cancelled: true });
      child.emit("close", 0, null);
    });
    const verdict = await pickFolder({ platform: "win32", tempRoot: root, spawnImpl: fake.impl });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.cancelled, true);
    assert.equal(listDir(root).length, 0);
  });

  it("falls back to Windows PowerShell when pwsh is not installed", { skip: !windows }, async () => {
    const root = dir("fallback");
    const selected = dir("selected-fallback");
    const fake = fakeSpawn(({ exe, dir: scriptDir, child }) => {
      if (exe === "pwsh.exe") {
        child.stderr.emit("data", Buffer.from("pwsh.exe : The term 'pwsh.exe' is not recognized\n"));
        child.emit("close", 1, null);
        return;
      }
      writeResult(scriptDir, { cancelled: false, path: selected });
      child.emit("close", 0, null);
    });
    const verdict = await pickFolder({ platform: "win32", tempRoot: root, spawnImpl: fake.impl });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.path, selected);
    assert.deepEqual(fake.calls.map((call) => call.exe), ["pwsh.exe", "powershell.exe"]);
    assert.equal(verdict.shell, "powershell.exe");
  });

  it("reports unavailable when no shell can be started", { skip: !windows }, async () => {
    const root = dir("noshell");
    const fake = fakeSpawn(({ exe, child }) => {
      child.stderr.emit("data", Buffer.from(`${exe}: not recognized\n`));
      child.emit("close", 1, null);
    });
    const verdict = await pickFolder({ platform: "win32", tempRoot: root, spawnImpl: fake.impl });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.available, false);
    assert.match(verdict.message, /^The folder dialog is unavailable/);
  });

  it("reports a timeout when the dialog outlives its deadline", { skip: !windows }, async () => {
    const root = dir("timeout");
    const fake = fakeSpawn(({ child }) => {
      child.killed = true;
      child.emit("close", null, "SIGTERM");
    });
    const verdict = await pickFolder({ platform: "win32", tempRoot: root, timeoutMs: 5, spawnImpl: fake.impl });
    assert.equal(verdict.code, "PICKER_TIMEOUT");
    assert.equal(listDir(root).length, 0);
  });

  it("reports a spawn failure that is not a missing shell", { skip: !windows }, async () => {
    const root = dir("spawnfail");
    const fake = fakeSpawn(({ child }) => {
      const error = new Error("access denied");
      error.code = "EPERM";
      child.emit("error", error);
    });
    const verdict = await pickFolder({ platform: "win32", tempRoot: root, spawnImpl: fake.impl });
    assert.equal(verdict.available, true);
    assert.equal(verdict.code, "PICKER_SPAWN_FAILED");
    assert.match(verdict.message, /^Could not start the folder dialog \(access denied\)/);
  });

  it("reports a real shell that exits with an error, and still cleans up", { skip: !windows || !canSpawn() }, async () => {
    const root = dir("realshell");
    // node.exe rejects PowerShell's flags, which is a real non-zero exit with a
    // real stderr: the picker must report it, not hang or cancel.
    const verdict = await pickFolder({ platform: "win32", tempRoot: root, shell: process.execPath, timeoutMs: 20000 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.cancelled, false);
    assert.equal(typeof verdict.code, "string");
    assert.notEqual(verdict.code, "PICKER_CANCELLED");
    assert.equal(listDir(root).length, 0);
  });
});
