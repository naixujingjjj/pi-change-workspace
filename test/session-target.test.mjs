import assert from "node:assert/strict";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { planTargetSession, removeOwnedHeaderFile } from "../src/session-target.js";
import {
  fakeSessionManager,
  importPiApi,
  listDir,
  piPackageDir,
  readSessionJsonl,
  removeTempDir,
  sha256,
  tempDir,
  writeFile,
} from "./helpers.mjs";

const dirs = [];
function dir(label) {
  const created = tempDir(label);
  dirs.push(created);
  return created;
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir = null;
let pi = null;
let skipReason = null;

before(async () => {
  if (!piPackageDir()) {
    skipReason = "the installed @earendil-works/pi-coding-agent package was not found";
    return;
  }
  agentDir = dir("agent-home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  pi = await importPiApi();
});

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const created of dirs) removeTempDir(created);
});

/** A real session file with one user message, created through Pi's own API. */
function sourceSession({ cwd, sessionDir, text = "OLD SESSION MESSAGE" }) {
  const manager = pi.SessionManager.create(cwd, sessionDir);
  manager.appendMessage({ role: "user", content: text, timestamp: 1733234400000 });
  return { manager, file: manager.getSessionFile(), id: manager.getSessionId() };
}

function encodedSessionsDir(cwd, agent = agentDir) {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agent, "sessions", safe);
}

describe("planTargetSession", () => {
  it("creates a header-only session whose cwd is the target, in the target's own storage", (t) => {
    if (skipReason) return t.skip(skipReason);
    const root = dir("default-storage");
    const projectA = join(root, "project A");
    const projectB = join(root, "project 测试 B");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });

    const source = sourceSession({ cwd: projectA });
    const beforeHash = sha256(source.file);

    const plan = planTargetSession({
      SessionManager: pi.SessionManager,
      targetCwd: projectB,
      currentCwd: projectA,
      currentSessionDir: source.manager.getSessionDir(),
      currentSessionFile: source.file,
    });

    assert.equal(plan.ok, true, plan.message);
    assert.equal(plan.storage, "target-default");
    assert.equal(plan.header.type, "session");
    assert.equal(plan.header.version, pi.CURRENT_SESSION_VERSION);
    assert.equal(plan.header.cwd, projectB);
    assert.equal(plan.header.parentSession, undefined);
    assert.equal(plan.sessionId, plan.header.id);
    assert.equal(existsSync(plan.sessionFile), true, "the header file must exist before the switch");
    assert.deepEqual(readSessionJsonl(plan.sessionFile), [JSON.parse(JSON.stringify(plan.header))]);
    assert.equal(dirname(plan.sessionFile).toLowerCase(), encodedSessionsDir(projectB).toLowerCase());

    // Pi itself can open it, and it reports the target cwd with no history.
    const opened = pi.SessionManager.open(plan.sessionFile);
    assert.equal(opened.getCwd(), projectB);
    assert.equal(opened.getSessionId(), plan.sessionId);
    assert.deepEqual(opened.getEntries(), []);
    assert.equal(opened.isPersisted(), true);

    // The source session is untouched.
    assert.equal(sha256(source.file), beforeHash);
  });

  it("keeps an explicit session storage override", (t) => {
    if (skipReason) return t.skip(skipReason);
    const root = dir("explicit-storage");
    const projectA = join(root, "a");
    const projectB = join(root, "b");
    const explicit = join(root, "explicit sessions");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    mkdirSync(explicit, { recursive: true });

    const source = sourceSession({ cwd: projectA, sessionDir: explicit });
    const plan = planTargetSession({
      SessionManager: pi.SessionManager,
      targetCwd: projectB,
      currentCwd: projectA,
      currentSessionDir: source.manager.getSessionDir(),
      currentSessionFile: source.file,
    });
    assert.equal(plan.ok, true, plan.message);
    assert.equal(plan.storage, "explicit");
    assert.equal(dirname(plan.sessionFile), explicit);
    assert.equal(plan.header.cwd, projectB);
  });

  it("refuses without a persisted session, for --no-session", (t) => {
    if (skipReason) return t.skip(skipReason);
    const root = dir("no-session");
    mkdirSync(root, { recursive: true });
    const memory = pi.SessionManager.inMemory(root);
    assert.equal(memory.getSessionFile(), undefined);
    const plan = planTargetSession({
      SessionManager: pi.SessionManager,
      targetCwd: root,
      currentCwd: root,
      currentSessionDir: memory.getSessionDir(),
      currentSessionFile: memory.getSessionFile(),
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, "NO_SESSION");
    assert.match(plan.message, /--no-session/);
  });

  it("refuses without the Pi session API", () => {
    const plan = planTargetSession({ targetCwd: "F:\\x", currentCwd: "F:\\y", currentSessionFile: "F:\\s.jsonl" });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, "NO_API");
  });

  it("never overwrites an existing session file and retries with a new id", () => {
    const root = dir("collision");
    const first = join(root, "2026-01-01_aaa.jsonl");
    const second = join(root, "2026-01-02_bbb.jsonl");
    writeFile(first, "{}\n");
    const fake = fakeSessionManager([first, second]);
    const conversationFile = join(root, "source.jsonl");
    writeFile(conversationFile, '{"type":"session"}\n');
    const plan = planTargetSession({
      SessionManager: fake.SessionManager,
      targetCwd: join(root, "target"),
      currentCwd: join(root, "current"),
      currentSessionDir: undefined,
      currentSessionFile: conversationFile,
    });
    assert.equal(plan.ok, true, plan.message);
    assert.equal(plan.sessionFile, second);
    assert.equal(fake.manager.newSessionCalls, 1);
    assert.equal(existsSync(second), true);
    assert.equal(fake.created[0].cwd, join(root, "target"));
    assert.equal(fake.created[0].sessionDir, undefined);
  });

  it("uses Pi's own default-directory answer without computing anything", () => {
    const root = dir("pi-answer");
    const file = join(root, "only.jsonl");
    const fake = fakeSessionManager([file]);
    fake.SessionManager.create = (cwd, sessionDir) => {
      fake.created.push({ cwd, sessionDir });
      return fake.manager;
    };
    const plan = planTargetSession({
      SessionManager: fake.SessionManager,
      targetCwd: join(root, "target"),
      currentCwd: join(root, "current"),
      currentSessionDir: join(root, "wherever"),
      currentSessionFile: join(root, "source.jsonl"),
      currentSessionDirIsDefault: true,
    });
    assert.equal(plan.ok, true, plan.message);
    assert.equal(plan.storage, "target-default");
    assert.equal(fake.created[0].sessionDir, undefined);

    const explicitFile = join(root, "explicit.jsonl");
    const explicitFake = fakeSessionManager([explicitFile]);
    const explicit = planTargetSession({
      SessionManager: explicitFake.SessionManager,
      targetCwd: join(root, "target-2"),
      currentCwd: join(root, "current"),
      currentSessionDir: join(root, "explicit"),
      currentSessionFile: join(root, "source.jsonl"),
      currentSessionDirIsDefault: false,
    });
    assert.equal(explicit.ok, true, explicit.message);
    assert.equal(explicit.storage, "explicit");
    assert.equal(explicitFake.created.at(-1).sessionDir, join(root, "explicit"));
  });

  it("reports a storage failure as a short error", () => {
    const SessionManager = {
      create() {
        throw new Error("EPERM: mkdir denied\nsecond line");
      },
    };
    const plan = planTargetSession({
      SessionManager,
      targetCwd: "F:\\target",
      currentCwd: "F:\\current",
      currentSessionFile: "F:\\source.jsonl",
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, "FAILED");
    assert.equal(plan.message, "Could not create a session: EPERM: mkdir denied");
  });
});

describe("removeOwnedHeaderFile", () => {
  it("removes the untouched header line it wrote", (t) => {
    if (skipReason) return t.skip(skipReason);
    const root = dir("cleanup");
    const projectA = join(root, "a");
    const projectB = join(root, "b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    const source = sourceSession({ cwd: projectA });
    const plan = planTargetSession({
      SessionManager: pi.SessionManager,
      targetCwd: projectB,
      currentCwd: projectA,
      currentSessionDir: source.manager.getSessionDir(),
      currentSessionFile: source.file,
    });
    assert.equal(plan.ok, true, plan.message);
    const removal = removeOwnedHeaderFile({ sessionFile: plan.sessionFile, header: plan.header });
    assert.deepEqual(removal, { removed: true, left: false });
    assert.equal(existsSync(plan.sessionFile), false);
    assert.equal(listDir(dirname(plan.sessionFile)).some((name) => name.endsWith(".jsonl")), false);
  });

  it("leaves a file that another writer has touched", () => {
    const root = dir("changed");
    const file = join(root, "session.jsonl");
    const header = { type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "F:\\target" };
    writeFile(file, `${JSON.stringify(header)}\n`);
    appendFileSync(file, `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } })}\n`, "utf8");
    const removal = removeOwnedHeaderFile({ sessionFile: file, header });
    assert.equal(removal.removed, false);
    assert.equal(removal.left, true);
    assert.equal(removal.reason, "content-changed");
    assert.equal(existsSync(file), true);
  });

  it("leaves a file whose header is not the one we wrote", () => {
    const root = dir("other-header");
    const file = join(root, "session.jsonl");
    const header = { type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "F:\\target" };
    const other = { ...header, id: "def" };
    writeFile(file, `${JSON.stringify(other)}\n`);
    const removal = removeOwnedHeaderFile({ sessionFile: file, header });
    assert.equal(removal.left, true);
    assert.equal(removal.reason, "content-changed");
  });

  it("leaves unreadable content alone and tolerates an already missing file", () => {
    const root = dir("unreadable");
    const file = join(root, "session.jsonl");
    const header = { type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "F:\\target" };
    writeFile(file, "not json\n");
    const removal = removeOwnedHeaderFile({ sessionFile: file, header });
    assert.equal(removal.left, true);
    assert.equal(removal.reason, "unreadable");
    const missing = removeOwnedHeaderFile({ sessionFile: join(root, "gone.jsonl"), header });
    assert.deepEqual(missing, { removed: false, left: false, missing: true });
    assert.deepEqual(removeOwnedHeaderFile({}), { removed: false, left: false, missing: true });
  });
});