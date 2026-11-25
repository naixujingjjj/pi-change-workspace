import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  PATH_CODES,
  canonicalizeDirectory,
  expandHome,
  normalizeForCompare,
  samePath,
  shorten,
  stripOuterQuotes,
  toAbsolute,
} from "../src/target-path.js";
import { removeTempDir, readText, tempDir, writeFile } from "./helpers.mjs";

const dirs = [];
function dir(label) {
  const created = tempDir(label);
  dirs.push(created);
  return created;
}

after(() => {
  for (const created of dirs) removeTempDir(created);
});

describe("canonicalizeDirectory", () => {
  it("rejects an empty or whitespace-only pick", () => {
    for (const value of ["", "   ", undefined, null, '""']) {
      const result = canonicalizeDirectory(value, { cwd: dir("empty") });
      assert.equal(result.ok, false);
      assert.equal(result.code, PATH_CODES.EMPTY);
      assert.equal(result.message, "Enter a folder path.");
    }
  });

  it("rejects control characters instead of passing them to the filesystem", () => {
    const result = canonicalizeDirectory("C:\\work\u0000x", { cwd: dir("control") });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATH_CODES.CONTROL_CHARS);
  });

  it("reports a missing folder in one short line", () => {
    const root = dir("missing");
    const result = canonicalizeDirectory(join(root, "does-not-exist"), { cwd: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATH_CODES.NOT_FOUND);
    assert.match(result.message, /^Folder not found: /);
    assert.equal(result.message.split("\n").length, 1);
  });

  it("reports a file as not a folder", () => {
    const root = dir("file");
    const file = join(root, "notes.txt");
    writeFileSync(file, "x", "utf8");
    const result = canonicalizeDirectory(file, { cwd: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATH_CODES.NOT_DIRECTORY);
    assert.match(result.message, /^Not a folder: /);
  });

  it("resolves relative paths against the Pi session cwd", () => {
    const root = dir("relative");
    const child = join(root, "child");
    mkdirSync(child);
    const result = canonicalizeDirectory("child", { cwd: root });
    assert.equal(result.ok, true);
    assert.equal(result.path.toLowerCase(), child.toLowerCase());
  });

  it("keeps Unicode, spaces and literal special characters intact", () => {
    const root = dir("unicode");
    const name = "测试 空格 & 'single' [brackets] #hash $dollar %percent (paren)";
    const target = join(root, name);
    mkdirSync(target);
    const result = canonicalizeDirectory(target, { cwd: root });
    assert.equal(result.ok, true);
    assert.equal(result.path, target);
    assert.equal(result.requested, target);
  });

  it("strips one pair of surrounding quotes but keeps inner quotes", () => {
    assert.equal(stripOuterQuotes('"C:\\work dir"'), "C:\\work dir");
    assert.equal(stripOuterQuotes("\"it's\""), "it's");
    assert.equal(stripOuterQuotes('C:\\a"b'), 'C:\\a"b');
    const root = dir("quoted");
    const quoted = join(root, "with space");
    mkdirSync(quoted);
    const result = canonicalizeDirectory(`"${quoted}"`, { cwd: root });
    assert.equal(result.ok, true);
    assert.equal(result.path, quoted);
  });

  it("accepts a trailing separator and duplicate separators", () => {
    const root = dir("trailing");
    const target = join(root, "folder");
    mkdirSync(target);
    const result = canonicalizeDirectory(`${target}\\`, { cwd: root });
    assert.equal(result.ok, true);
    assert.equal(result.path, target);
    const doubled = canonicalizeDirectory(`${target}\\\\`, { cwd: root });
    assert.equal(doubled.ok, true);
    assert.equal(doubled.path, target);
  });

  it("expands ~ against the home directory", () => {
    const home = dir("home");
    assert.equal(expandHome("~", home), home);
    assert.equal(expandHome("~/sub", home), join(home, "sub"));
    assert.equal(expandHome("~\\sub", home), join(home, "sub"));
    assert.equal(expandHome("C:\\plain", home), "C:\\plain");
    assert.equal(toAbsolute("sub", home), join(home, "sub"));
  });
});

describe("samePath", () => {
  const windows = process.platform === "win32";

  it("treats Windows paths case-insensitively and ignores trailing separators", () => {
    const root = dir("same");
    const target = join(root, "MixedCase");
    mkdirSync(target);
    assert.equal(samePath(target, target.toLowerCase()), true);
    assert.equal(samePath(target, target.toUpperCase()), true);
    assert.equal(samePath(target, `${target}\\`), true);
  });

  it("distinguishes different directories that share a prefix", () => {
    const root = dir("different");
    const one = join(root, "one");
    const two = join(root, "two");
    mkdirSync(one);
    mkdirSync(two);
    assert.equal(samePath(one, two), false);
    assert.equal(samePath(one, join(root, "one", "nested")), false);
  });

  it("normalizes separators and casing for comparison", () => {
    const value = normalizeForCompare("F:\\Work\\Dir\\");
    if (windows) {
      assert.equal(value, "f:\\work\\dir");
      assert.equal(normalizeForCompare("F:/Work/Dir"), "f:\\work\\dir");
    } else {
      assert.equal(typeof value, "string");
    }
  });

  it("never treats an empty value as a match", () => {
    assert.equal(samePath("", ""), false);
    assert.equal(samePath("   ", "F:\\dsh"), false);
  });
});

describe("shorten", () => {
  it("keeps short text and truncates long text with an ellipsis", () => {
    assert.equal(shorten("abc", 10), "abc");
    assert.equal(shorten("abcdefghij", 5), "abcd…");
  });
});

describe("fixture helpers", () => {
  it("creates nested files for fixtures", () => {
    const root = dir("write");
    const file = writeFile(join(root, "deep", "nested", "file.txt"), "ok");
    assert.equal(readText(file), "ok");
  });
});