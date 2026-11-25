// A fresh, empty Pi session whose header names the new workspace.
//
// Pi rebuilds its runtime from the target session's header `cwd` when a session
// is switched with `ctx.switchSession(path)`; `ctx.newSession()` has no cwd
// option. A brand-new session therefore has to exist as a real session file
// before the switch, because `SessionManager.open()` falls back to the *current*
// process cwd when the file is missing.
//
// `SessionManager.create(targetCwd)` already computes exactly the right file
// path, session id and header (including Pi's own session version), but it is
// lazy: the file is written only when the first user/assistant message arrives.
// This module materializes that one header line with the exclusive `wx` flag,
// so a pre-existing file can never be overwritten, and keeps the exact header
// object for an ownership-checked cleanup if the switch never happens.
//
// Session storage:
//  * default storage → the target project's own session directory, which Pi
//    derives from the target cwd (so the new session shows up under the folder
//    it belongs to);
//  * an explicit `--session-dir` (or a session file outside the current
//    project's default directory) → kept as-is, matching what Pi's own `/new`
//    does with `getSessionDir()`.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { samePath } from "./target-path.js";

export const TARGET_SESSION_CODES = Object.freeze({
  NO_SESSION: "NO_SESSION",
  NO_API: "NO_API",
  FAILED: "FAILED",
});

const MAX_ATTEMPTS = 3;

function firstLine(error) {
  const text = String(error?.message || error || "unknown error");
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "unknown error";
}

/** Whether the current session directory is the one Pi would use by default. */
function isDefaultSessionDir(SessionManager, cwd, sessionDir) {
  if (!sessionDir) return true;
  try {
    return samePath(SessionManager.create(cwd).getSessionDir(), sessionDir);
  } catch {
    // If the default cannot be computed, keeping the current directory is the
    // conservative choice: an explicit override is preserved, not dropped.
    return false;
  }
}

/**
 * Create the target session file (header only) and describe it for the switch.
 *
 * Returns `{ ok: true, sessionFile, header, sessionId, sessionDir, storage }`
 * or `{ ok: false, code, message }`. Nothing in the source session is read or
 * written here.
 */
export function planTargetSession({
  SessionManager,
  targetCwd,
  currentCwd,
  currentSessionDir = undefined,
  currentSessionFile = undefined,
  currentSessionDirIsDefault = undefined,
} = {}) {
  if (!SessionManager || typeof SessionManager.create !== "function") {
    return { ok: false, code: TARGET_SESSION_CODES.NO_API, message: "Pi session API unavailable." };
  }
  if (!currentSessionFile) {
    return {
      ok: false,
      code: TARGET_SESSION_CODES.NO_SESSION,
      message: "Workspace switching needs saved sessions. Start Pi without --no-session.",
    };
  }
  if (!targetCwd) {
    return { ok: false, code: TARGET_SESSION_CODES.FAILED, message: "No target folder." };
  }

  const defaultDir =
    typeof currentSessionDirIsDefault === "boolean"
      ? currentSessionDirIsDefault
      : isDefaultSessionDir(SessionManager, currentCwd, currentSessionDir);
  const storage = defaultDir ? "target-default" : "explicit";
  const sessionDir = storage === "explicit" ? currentSessionDir : undefined;

  let manager;
  try {
    manager = SessionManager.create(targetCwd, sessionDir);
  } catch (error) {
    return { ok: false, code: TARGET_SESSION_CODES.FAILED, message: `Could not create a session: ${firstLine(error)}` };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const sessionFile = manager.getSessionFile();
    const header = manager.getHeader();
    if (!sessionFile || !header) {
      return { ok: false, code: TARGET_SESSION_CODES.FAILED, message: "Could not create a session: no session file." };
    }
    if (existsSync(sessionFile)) {
      // Astronomically unlikely (timestamp + UUID), and still never overwritten.
      manager.newSession();
      continue;
    }
    let fd = null;
    try {
      fd = openSync(sessionFile, "wx");
      writeFileSync(fd, `${JSON.stringify(header)}\n`, "utf8");
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
        fd = null;
      }
      if (error?.code === "EEXIST") {
        manager.newSession();
        continue;
      }
      return { ok: false, code: TARGET_SESSION_CODES.FAILED, message: `Could not create a session: ${firstLine(error)}` };
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed by the write path
        }
      }
    }
    return {
      ok: true,
      code: null,
      sessionFile,
      header,
      sessionId: header.id,
      sessionDir: manager.getSessionDir(),
      storage,
      targetCwd,
    };
  }

  return { ok: false, code: TARGET_SESSION_CODES.FAILED, message: "Could not create a fresh session file." };
}

/**
 * Remove the file this command created, but only while it is provably still the
 * one untouched header line we wrote. A file whose content changed (Pi wrote to
 * it, or someone else did) belongs to that other writer and is left alone.
 */
export function removeOwnedHeaderFile({ sessionFile, header } = {}) {
  if (!sessionFile || !header) return { removed: false, left: false, missing: true };
  let raw;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: false, left: false, missing: true };
    return { removed: false, left: true, reason: "unreadable", message: firstLine(error) };
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 1) return { removed: false, left: true, reason: "content-changed" };
  let parsed = null;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    return { removed: false, left: true, reason: "unreadable" };
  }
  if (JSON.stringify(parsed) !== JSON.stringify(header)) {
    return { removed: false, left: true, reason: "content-changed" };
  }
  try {
    unlinkSync(sessionFile);
    return { removed: true, left: false };
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: false, left: false, missing: true };
    return { removed: false, left: true, reason: "unlink-failed", message: firstLine(error) };
  }
}