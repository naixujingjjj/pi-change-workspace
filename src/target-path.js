// Workspace target normalization: what the user picked, as a real directory.
//
// Every failure is a short, specific sentence the command can show as-is:
// "not found", "not a folder", "access denied". Cancellation is never an error
// here; it is reported by the picker, and an empty selection never reaches this
// module.
//
// The comparison helper exists because Windows is case-insensitive: `F:\work`
// and `f:\WORK` are the same workspace and switching between them must be a
// no-op, not a session replacement into an identical directory.
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, resolve } from "node:path";

export const PATH_CODES = Object.freeze({
  EMPTY: "EMPTY",
  CONTROL_CHARS: "CONTROL_CHARS",
  NOT_FOUND: "NOT_FOUND",
  NOT_DIRECTORY: "NOT_DIRECTORY",
  DENIED: "DENIED",
  FAILED: "FAILED",
});

/** Keep messages readable without dropping the information a user needs. */
export function shorten(value, limit = 160) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

/**
 * One pair of surrounding double quotes is accepted, because people paste paths
 * that way; nothing else about the text is rewritten.
 */
export function stripOuterQuotes(value) {
  const text = String(value ?? "");
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

/** `~`, `~/x` and `~\x` expand to the user's home directory. */
export function expandHome(value, home = homedir()) {
  const text = String(value ?? "");
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return join(home, text.slice(2));
  return text;
}

/** Make a user-typed path absolute against the session cwd. */
export function toAbsolute(value, cwd) {
  const text = String(value ?? "");
  return isAbsolute(text) ? normalize(text) : resolve(String(cwd ?? process.cwd()), text);
}

function errorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "ENOENT") return PATH_CODES.NOT_FOUND;
  if (code === "ENOTDIR") return PATH_CODES.NOT_DIRECTORY;
  if (code === "EACCES" || code === "EPERM") return PATH_CODES.DENIED;
  return PATH_CODES.FAILED;
}

function failure(error, shown) {
  const code = errorCode(error);
  const label = shorten(shown);
  if (code === PATH_CODES.NOT_FOUND) {
    return { ok: false, code, message: `Folder not found: ${label}` };
  }
  if (code === PATH_CODES.NOT_DIRECTORY) {
    return { ok: false, code, message: `Not a folder: ${label}` };
  }
  if (code === PATH_CODES.DENIED) {
    return { ok: false, code, message: `Access denied: ${label}` };
  }
  const detail = shorten(error?.message || error || "unknown error", 80);
  return { ok: false, code, message: `Could not open ${label} (${detail})` };
}

/**
 * Resolve one picked or typed folder to its canonical absolute path.
 *
 * `path` is what the rest of the command uses: the runtime cwd of the new
 * session is stored from exactly this value, so it must be a directory that
 * exists now and is spelled the way Windows itself spells it.
 */
export function canonicalizeDirectory(input, { cwd = process.cwd(), platform = process.platform, literal = false } = {}) {
  const value = String(input ?? "");
  const raw = literal ? value : stripOuterQuotes(value.trim());
  if (!raw.trim()) {
    return { ok: false, code: PATH_CODES.EMPTY, message: "Enter a folder path." };
  }
  if (/[\u0000-\u001f]/.test(raw)) {
    return { ok: false, code: PATH_CODES.CONTROL_CHARS, message: "That path contains control characters." };
  }
  const absolute = toAbsolute(expandHome(raw), cwd);
  let real;
  try {
    real = realpathSync.native(absolute);
  } catch (error) {
    return failure(error, absolute);
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, code: PATH_CODES.NOT_DIRECTORY, message: `Not a folder: ${shorten(absolute)}` };
    }
  } catch (error) {
    return failure(error, absolute);
  }
  return { ok: true, code: null, path: real, requested: absolute, platform };
}

/**
 * Compare two directories the way the host filesystem does.
 *
 * Both sides are canonicalized when they exist, which folds case, 8.3 short
 * names and junctions; a trailing separator is ignored unless it is the root.
 */
export function normalizeForCompare(value, { platform = process.platform } = {}) {
  let text = String(value ?? "");
  if (!text.trim()) return "";
  try {
    text = realpathSync.native(text);
  } catch {
    try {
      text = resolve(text);
    } catch {
      // keep the resolved-enough text; comparison below still normalizes it
    }
  }
  if (platform === "win32") {
    text = text.replace(/\//g, "\\");
    const root = parse(text).root;
    if (text.length > root.length) text = text.replace(/\\+$/, "");
    return text.toLowerCase();
  }
  const root = parse(text).root;
  if (text.length > root.length) text = text.replace(/\/+$/, "");
  return text;
}

/** True when both values name the same directory on this host. */
export function samePath(a, b, { platform = process.platform } = {}) {
  const left = normalizeForCompare(a, { platform });
  const right = normalizeForCompare(b, { platform });
  return Boolean(left) && left === right;
}
