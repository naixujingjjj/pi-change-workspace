// Shared test fixtures: temp directories, the installed Pi package, fake
// command contexts, and a minimal JSONL RPC client for the integration test.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TMP_ROOT = join(REPO_ROOT, ".tmp");

let counter = 0;

export function tempDir(label = "case") {
  counter += 1;
  const safe = String(label).replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 40) || "case";
  const dir = join(TMP_ROOT, `${safe}-${process.pid}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeTempDir(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  } catch {
    // best effort in a test cleanup
  }
}

export function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Candidate locations for the Pi package this machine actually runs. */
export function piPackageCandidates() {
  const candidates = [];
  if (process.env.PI_WORKSPACE_PI_PACKAGE) candidates.push(process.env.PI_WORKSPACE_PI_PACKAGE);
  candidates.push(join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
  const appData = process.env.APPDATA;
  if (appData) candidates.push(join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent"));
  const fromNpm = globalNpmRoot();
  if (fromNpm) candidates.push(join(fromNpm, "@earendil-works", "pi-coding-agent"));
  candidates.push(join("/usr", "local", "lib", "node_modules", "@earendil-works", "pi-coding-agent"));
  candidates.push(join(homedir(), ".pi", "agent", "npm", "node_modules", "@earendil-works", "pi-coding-agent"));
  return candidates;
}

let cachedNpmRoot;

function globalNpmRoot() {
  if (cachedNpmRoot !== undefined) return cachedNpmRoot;
  cachedNpmRoot = null;
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npm, ["root", "-g"], { encoding: "utf8", timeout: 20000 });
    const line = String(result.stdout || "").trim().split(/\r?\n/).pop();
    if (line && existsSync(line)) cachedNpmRoot = line;
  } catch {
    // no npm on PATH: the other candidates still apply
  }
  return cachedNpmRoot;
}

export function piPackageDir() {
  for (const candidate of piPackageCandidates()) {
    try {
      if (candidate && existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function piTuiDir() {
  const pkg = piPackageDir();
  if (!pkg) return null;
  const nested = join(pkg, "node_modules", "@earendil-works", "pi-tui");
  if (existsSync(join(nested, "package.json"))) return nested;
  return null;
}

export async function importPiApi() {
  const pkg = piPackageDir();
  if (!pkg) throw new Error("The installed @earendil-works/pi-coding-agent package was not found.");
  return import(pathToFileURL(join(pkg, "dist", "index.js")).href);
}

export async function importPiTui() {
  const dir = piTuiDir();
  if (!dir) throw new Error("The installed @earendil-works/pi-tui package was not found.");
  return import(pathToFileURL(join(dir, "dist", "index.js")).href);
}

/**
 * Make `@earendil-works/pi-coding-agent` resolvable for the test process, the
 * same way Pi maps it for extensions: a directory junction to the installed
 * package. Without a local copy, the extension entry cannot be imported here.
 */
export function ensurePiLink() {
  const pkg = piPackageDir();
  if (!pkg) return null;
  const linkParent = join(REPO_ROOT, "node_modules", "@earendil-works");
  const linkPath = join(linkParent, "pi-coding-agent");
  try {
    mkdirSync(linkParent, { recursive: true });
    if (!existsSync(linkPath)) symlinkSync(pkg, linkPath, "junction");
    return pkg;
  } catch {
    return existsSync(linkPath) ? pkg : null;
  }
}

/** Whether this process is allowed to start child processes at all. */
export function canSpawn() {
  try {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 20000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * A command context with the surface `/workspace` uses, plus a recorder so
 * tests can assert on exactly what the user would have seen.
 */
export function makeContext(overrides = {}) {
  const notes = [];
  const prompts = [];
  const confirmations = [];
  const switches = [];
  const ctx = {
    mode: overrides.mode ?? "tui",
    hasUI: true,
    cwd: overrides.cwd ?? process.cwd(),
    sessionManager: {
      getSessionFile: () => ("sessionFile" in overrides ? overrides.sessionFile : join(TMP_ROOT, "source-session.jsonl")),
      getCwd: () => overrides.cwd ?? process.cwd(),
      getSessionDir: () => overrides.sessionDir ?? join(TMP_ROOT, "source-sessions"),
      getSessionId: () => "source-session-id",
    },
    // Mutable on purpose: a test can set `ctx.inputAnswer` after creating the
    // context, once the target directory it wants to return exists.
    inputAnswer: overrides.inputAnswer,
    confirmAnswer: overrides.confirmAnswer,
    ui: {
      notify: (message, level) => notes.push({ message, level: level ?? "info" }),
      input: async (title, placeholder) => {
        prompts.push({ title, placeholder });
        return ctx.inputAnswer;
      },
      confirm: async (title, message) => {
        confirmations.push({ title, message });
        return ctx.confirmAnswer === true;
      },
      addAutocompleteProvider: (factory) => {
        ctx.autocompleteWrappers.push(factory);
      },
    },
    autocompleteWrappers: [],
    isIdle: () => overrides.idle !== false,
    hasPendingMessages: () => overrides.pending === true,
    switchSession: async (sessionPath, options) => {
      switches.push({ sessionPath, options });
      if (overrides.switchImpl) return overrides.switchImpl(sessionPath, options, ctx);
      if (overrides.switchThrows) throw overrides.switchThrows;
      if (overrides.switchVeto) return { cancelled: true };
      const nextCtx = {
        ...ctx,
        cwd: overrides.nextCwd ?? overrides.cwd,
        ui: { ...ctx.ui },
        notesFor: notes,
      };
      ctx.stale = true;
      if (options?.withSession) await options.withSession(nextCtx);
      return { cancelled: false };
    },
    notes,
    prompts,
    confirmations,
    switches,
  };
  // A stale command context is replaced by Pi with throwing accessors.
  if (overrides.staleAfterSwitch) {
    const realSwitch = ctx.switchSession;
    ctx.switchSession = async (...args) => {
      const result = await realSwitch(...args);
      ctx.sessionManager = new Proxy({}, { get() { throw new Error("This extension ctx is stale after session replacement."); } });
      return result;
    };
  }
  return Object.assign(ctx, overrides.ctx ?? {});
}

/** A fake SessionManager good enough for `planTargetSession` collision tests. */
export function fakeSessionManager(paths) {
  let index = 0;
  const created = [];
  const manager = {
    newSessionCalls: 0,
    files: paths,
    getSessionFile: () => paths[Math.min(index, paths.length - 1)],
    getHeader: () => ({ type: "session", version: 3, id: `fake-${index}`, timestamp: "2026-01-01T00:00:00.000Z", cwd: "F:\\fake" }),
    getSessionDir: () => dirname(paths[0]),
    newSession() {
      manager.newSessionCalls += 1;
      index += 1;
      return paths[Math.min(index, paths.length - 1)];
    },
  };
  const SessionManager = {
    create(cwd, sessionDir) {
      created.push({ cwd, sessionDir });
      return manager;
    },
  };
  return { SessionManager, manager, created };
}

/** Read one JSONL session file into its raw entries. */
export function readSessionJsonl(path) {
  return readText(path)
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Minimal line-oriented JSONL client for `pi --mode rpc`. */
export function startPiRpc({ cliPath, args, cwd, env = {}, onEvent = null }) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const events = [];
  const waiters = [];
  let stdoutBuffer = "";
  let stderr = "";
  let exited = false;
  let exitInfo = null;

  const notifyWaiters = () => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate(events)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(waiter.predicate(events));
      }
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const index = stdoutBuffer.indexOf("\n");
      if (index < 0) break;
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // not a protocol record
      }
      events.push(record);
      onEvent?.(record);
      notifyWaiters();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal, stderr };
    notifyWaiters();
  });

  const send = (command) => {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  };

  const waitFor = (predicate, { timeoutMs = 30000, label = "record" } = {}) => {
    const existing = predicate(events);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        timer: setTimeout(() => {
          const seen = events.map((event) => event.type).join(", ");
          reject(new Error(`Timed out waiting for ${label}. Records seen: ${seen}. stderr: ${stderr.slice(-800)}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
      if (exited) notifyWaiters();
    });
  };

  const waitResponse = (id, options = {}) =>
    waitFor((list) => list.find((event) => event.type === "response" && event.id === id), { label: `response ${id}`, ...options });

  /** Poll an async check; for state that is visible only through later commands. */
  const waitUntil = async (check, { timeoutMs = 30000, intervalMs = 100, label = "condition" } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      try {
        const value = await check();
        if (value) return value;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}. stderr: ${stderr.slice(-800)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  const waitUiRequest = (method, options = {}) =>
    waitFor(
      (list) => list.find((event) => event.type === "extension_ui_request" && event.method === method),
      { label: `extension_ui_request ${method}`, ...options },
    );

  const waitNotify = (text, options = {}) =>
    waitFor(
      (list) => list.find((event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes(text)),
      { label: `notify containing ${JSON.stringify(text)}`, ...options },
    );

  const respond = (id, payload) => send({ type: "extension_ui_response", id, ...payload });

  const close = async ({ timeoutMs = 15000 } = {}) => {
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    if (exited) return exitInfo;
    const exitedPromise = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    try {
      await exitedPromise;
    } finally {
      clearTimeout(timer);
    }
    return exitInfo;
  };

  return { child, events, send, waitFor, waitUntil, waitResponse, waitUiRequest, waitNotify, respond, close, getStderr: () => stderr };
}