// `/workspace`: pick a folder and continue in a fresh blank session for it.
//
// This is Pi's supported session replacement, not a directory flip:
//   * the native Windows dialog (or a typed path where the dialog cannot run)
//     chooses the target;
//   * a *new* session file whose header `cwd` is the target is created, so Pi
//     rebuilds its runtime — cwd, project context files (AGENTS.md), skills and
//     built-in tool paths — from the target when the session is switched;
//   * `ctx.switchSession()` does the replacement in this same process and TUI;
//     `withSession` reports the result against the replacement session.
//
// The source session is only ever read by Pi itself: no history is rewritten,
// copied or auto-restored, and the old conversation stays resumable.
import { canonicalizeDirectory, samePath } from "./target-path.js";
import { planTargetSession, removeOwnedHeaderFile } from "./session-target.js";

export const WORKSPACE_COMMAND_NAME = "workspace";
export const USAGE = "Usage: /workspace";
export const WORKSPACE_CONFIRM_TITLE = "Switch workspace?";

export const RESULT_CODES = Object.freeze({
  OK: "OK",
  CANCELLED: "CANCELLED",
  SAME: "SAME",
  VETOED: "VETOED",
  BUSY: "BUSY",
  NO_SESSION: "NO_SESSION",
  INVALID: "INVALID",
  UNAVAILABLE: "UNAVAILABLE",
  FAILED: "FAILED",
});

// One switch at a time, process-wide: a second `/workspace` while the dialog or
// the replacement is in flight must not create a second session file.
let inFlight = false;

/** Test seam: forget an in-flight invocation left behind by a failed assertion. */
export function resetWorkspaceCommandState() {
  inFlight = false;
}

export function isWorkspaceCommandRunning() {
  return inFlight;
}

function firstLine(text, limit = 200) {
  const source = text instanceof Error ? text.message : text;
  const line = String(source ?? "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  return line ? line.slice(0, limit) : "";
}

/**
 * Ask for the target folder.
 *
 * The native dialog is used in the interactive TUI only: it is a real Windows
 * window, and in RPC mode a host cannot click it. Everywhere else, and when the
 * dialog itself is unusable on this machine, the typed path prompt is the
 * documented fallback.
 */
async function pickTarget(ctx, deps, currentCwd) {
  const notify = (message, level) => {
    try {
      ctx.ui?.notify?.(message, level);
    } catch {
      // notifications are best effort
    }
  };
  const canDialog = ctx.mode === "tui" && typeof deps.pickFolder === "function";
  if (canDialog) {
    const picked = await deps.pickFolder({
      initialDir: currentCwd,
      description: "Select the workspace folder for Pi.",
    });
    if (picked?.ok) return { ok: true, path: picked.path, literal: true };
    if (picked?.cancelled) {
      notify(picked.message || "Canceled. Workspace unchanged.", "info");
      return { ok: false, code: RESULT_CODES.CANCELLED };
    }
    // Unavailable or failed: say why, then fall back to the typed path, which
    // keeps the command usable without WinForms or PowerShell.
    notify(picked?.message || "The folder dialog is unavailable. Type the folder path.", picked?.available === false ? "info" : "error");
  }

  if (typeof ctx.ui?.input !== "function") {
    notify("No folder can be chosen here. The workspace is unchanged.", "error");
    return { ok: false, code: RESULT_CODES.UNAVAILABLE };
  }
  const typed = await ctx.ui.input("Workspace folder path", currentCwd);
  if (typed === undefined) {
    notify("Canceled. Workspace unchanged.", "info");
    return { ok: false, code: RESULT_CODES.CANCELLED };
  }
  return { ok: true, path: typed };
}

/**
 * Run one `/workspace` invocation. `deps` exists so the tests can drive every
 * branch without a TUI, a dialog or a real Pi process; the extension passes the
 * real `SessionManager` and picker.
 */
export async function runWorkspaceCommand(ctx, { args = "", deps = {} } = {}) {
  const api = {
    pickFolder: null,
    canonicalize: canonicalizeDirectory,
    samePath,
    planTargetSession,
    removeOwnedHeaderFile,
    setWorkspacePath: null,
    ...deps,
  };
  const notify = (message, level = "info") => {
    try {
      ctx.ui?.notify?.(message, level);
    } catch {
      // notifications are best effort
    }
  };

  const rawArgs = String(args ?? "").trim();
  if (rawArgs) {
    notify(`${USAGE} takes no arguments.`, "error");
    return { ok: false, code: RESULT_CODES.INVALID, message: `${USAGE} takes no arguments.` };
  }

  if (inFlight) {
    notify("/workspace is already running.", "warning");
    return { ok: false, code: RESULT_CODES.BUSY };
  }
  inFlight = true;
  try {
    const manager = ctx.sessionManager;
    const sessionFile = (() => {
      try {
        return manager?.getSessionFile?.();
      } catch {
        return undefined;
      }
    })();
    const currentCwd = (() => {
      try {
        return manager?.getCwd?.() || ctx.cwd;
      } catch {
        return ctx.cwd;
      }
    })();
    const currentSessionDir = (() => {
      try {
        return manager?.getSessionDir?.();
      } catch {
        return undefined;
      }
    })();
    // `SessionManager.usesDefaultSessionDir()` is Pi's own answer and avoids
    // computing (and creating) a default directory just to compare paths. The
    // command context type is the read-only subset, so it is called defensively.
    const currentSessionDirIsDefault = (() => {
      try {
        return typeof manager?.usesDefaultSessionDir === "function" ? manager.usesDefaultSessionDir() === true : undefined;
      } catch {
        return undefined;
      }
    })();

    if (!sessionFile) {
      const message = "Workspace switching needs saved sessions. Start Pi without --no-session.";
      notify(message, "error");
      return { ok: false, code: RESULT_CODES.NO_SESSION, message };
    }
    if (!currentCwd) {
      const message = "Pi reports no current workspace.";
      notify(message, "error");
      return { ok: false, code: RESULT_CODES.FAILED, message };
    }

    const choice = await pickTarget(ctx, api, currentCwd);
    if (!choice.ok) return choice;

    const target = api.canonicalize(choice.path, { cwd: currentCwd, literal: choice.literal });
    if (!target.ok) {
      notify(target.message, "error");
      return { ok: false, code: RESULT_CODES.INVALID, message: target.message };
    }
    if (api.samePath(target.path, currentCwd)) {
      const message = `Already in ${target.path}`;
      notify(message, "info");
      return { ok: false, code: RESULT_CODES.SAME, message };
    }

    // A switch aborts the running response and drops queued input, because Pi
    // tears the old runtime down first. Ask before doing that.
    const idle = (() => {
      try {
        return ctx.isIdle() !== false;
      } catch {
        return true;
      }
    })();
    const pending = (() => {
      try {
        return ctx.hasPendingMessages() === true;
      } catch {
        return false;
      }
    })();
    if (!idle || pending) {
      if (typeof ctx.ui?.confirm !== "function") {
        const message = "Cannot switch workspace while Pi is busy.";
        notify(message, "error");
        return { ok: false, code: RESULT_CODES.UNAVAILABLE, message };
      }
      const confirmed = await ctx.ui.confirm(
        WORKSPACE_CONFIRM_TITLE,
        `${target.path}\n\nThe current response stops and queued input is dropped. This session stays resumable.`,
      );
      if (!confirmed) {
        notify("Workspace unchanged.", "info");
        return { ok: false, code: RESULT_CODES.CANCELLED };
      }
    }

    const plan = api.planTargetSession({
      SessionManager: api.SessionManager,
      targetCwd: target.path,
      currentCwd,
      currentSessionDir,
      currentSessionFile: sessionFile,
      currentSessionDirIsDefault,
    });
    if (!plan.ok) {
      const code = plan.code === "NO_SESSION" ? RESULT_CODES.NO_SESSION : RESULT_CODES.FAILED;
      notify(plan.message, "error");
      return { ok: false, code, message: plan.message };
    }

    let switched = false;
    let result = null;
    try {
      result = await ctx.switchSession(plan.sessionFile, {
        withSession: async (nextCtx) => {
          switched = true;
          try {
            api.setWorkspacePath?.(target.path);
          } catch {
            // the autocomplete row is cosmetic
          }
          try {
            nextCtx.ui?.notify?.(`Workspace: ${target.path}`, "info");
          } catch {
            // notifications are best effort
          }
        },
      });
    } catch (error) {
      const message = `Could not switch workspace: ${firstLine(error)}`;
      const cleanup = discardUnusedSession({ ctx, plan, api, switched, previousSessionFile: sessionFile });
      notify(message, "error");
      if (cleanup.left) notify(`Left unused session file: ${plan.sessionFile}`, "warning");
      return { ok: false, code: RESULT_CODES.FAILED, message, cleanup };
    }

    if (result?.cancelled) {
      // Another extension vetoed the switch in `session_before_switch`. Pi never
      // tore this session down, so the file we just made is still ours to drop.
      const cleanup = api.removeOwnedHeaderFile({ sessionFile: plan.sessionFile, header: plan.header });
      notify("Workspace switch canceled.", "info");
      if (cleanup.left) notify(`Left unused session file: ${plan.sessionFile}`, "warning");
      return { ok: false, code: RESULT_CODES.VETOED, cleanup };
    }

    return {
      ok: true,
      code: RESULT_CODES.OK,
      path: target.path,
      sessionFile: plan.sessionFile,
      sessionId: plan.sessionId,
      storage: plan.storage,
    };
  } finally {
    inFlight = false;
  }
}

/**
 * A failed switch leaves a header-only session file behind. Removing it is safe
 * only while this session is provably still the active one: Pi invalidates the
 * old extension context as soon as it replaces the runtime, so a readable
 * `sessionManager` that still reports the old file means nothing switched.
 * When that cannot be proven, the file is left in place and reported.
 */
function discardUnusedSession({ ctx, plan, api, switched, previousSessionFile }) {
  if (switched) return { removed: false, left: false, reason: "switched" };
  let stillActive = false;
  try {
    stillActive = ctx.sessionManager?.getSessionFile?.() === previousSessionFile;
  } catch {
    // stale context: the replacement may already have happened
    stillActive = false;
  }
  if (!stillActive) return { removed: false, left: true, reason: "outcome-uncertain" };
  return api.removeOwnedHeaderFile({ sessionFile: plan.sessionFile, header: plan.header });
}
