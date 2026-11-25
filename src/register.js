// Wiring: the `/workspace` command plus the live autocomplete row.
//
// Kept free of imports from Pi so it can be driven by the tests with a fake
// `pi` and a fake command context; the extension entry supplies `SessionManager`
// and the picker.
import { createWorkspaceRowProvider } from "./autocomplete.js";
import { runWorkspaceCommand, WORKSPACE_COMMAND_NAME } from "./command.js";

/** The registered description; the TUI row itself is replaced with the live cwd. */
export const WORKSPACE_COMMAND_DESCRIPTION =
  "Switch workspace: choose a folder and continue in a fresh session for it";

/**
 * Register everything on one `pi` API object.
 *
 * The workspace path shown in autocomplete is kept in this closure: Pi tears
 * down the extension instance on every replacement, rebuilds the autocomplete
 * provider from scratch (`resetExtensionUI()` clears wrappers first), and the
 * replacement instance receives its own `session_start`, so the closure always
 * describes the session that is now running.
 */
export function registerWorkspaceCommands(pi, deps = {}) {
  const state = { path: "" };
  const setWorkspacePath = (value) => {
    state.path = typeof value === "string" ? value : "";
  };
  const getWorkspacePath = () => state.path;

  const commandDeps = { ...deps, setWorkspacePath };

  pi.on("session_start", (_event, ctx) => {
    try {
      setWorkspacePath(ctx.cwd || ctx.sessionManager?.getCwd?.() || "");
    } catch {
      setWorkspacePath("");
    }
    try {
      if (ctx.mode === "tui" && typeof ctx.ui?.addAutocompleteProvider === "function") {
        ctx.ui.addAutocompleteProvider(createWorkspaceRowProvider(getWorkspacePath));
      }
    } catch {
      // Autocomplete is cosmetic: a host without this hook still gets the command.
    }
  });

  pi.registerCommand(WORKSPACE_COMMAND_NAME, {
    description: WORKSPACE_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      await runWorkspaceCommand(ctx, { args, deps: commandDeps });
    },
  });

  return { getWorkspacePath, setWorkspacePath };
}