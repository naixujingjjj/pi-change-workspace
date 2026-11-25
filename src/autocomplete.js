// The `/workspace` autocomplete row shows the current workspace, nothing else.
//
// Pi 1.6 builds its slash-command list for autocomplete from the *snapshot* of
// each registered command description, and prefixes extension descriptions with
// an origin tag such as `[u] ` (interactive-mode.js `prefixAutocompleteDescription`).
// A registered description is therefore the wrong place to put a live path: it
// would carry the tag, never refresh, and a replacement would show the old
// directory until the provider is rebuilt.
//
// `ctx.ui.addAutocompleteProvider(factory)` wraps the provider Pi just built and
// runs again after every session replacement. The wrapper below rewrites only
// the exact `/workspace` row, reading the live workspace at completion time, and
// returns every other item — including look-alike commands such as
// `/workspace-extra` — untouched.
export const WORKSPACE_COMMAND = "workspace";

/** True only for the exact `/workspace` row (not `/workspace-anything`). */
function isWorkspaceRow(item) {
  return Boolean(item) && typeof item === "object" && item.value === WORKSPACE_COMMAND && item.label === WORKSPACE_COMMAND;
}

/**
 * Replace the description of the `/workspace` row. The input is never mutated:
 * Pi's base provider keeps its own array, so a later rebuild cannot inherit a
 * patched row from a previous session.
 */
export function patchWorkspaceRow(suggestions, description) {
  if (!suggestions || !Array.isArray(suggestions.items)) return suggestions;
  if (typeof description !== "string" || !description) return suggestions;
  // Only the slash-command list: an argument completion whose value happens to
  // be "workspace" belongs to some other command.
  const prefix = suggestions.prefix;
  if (typeof prefix === "string" && (prefix.includes(" ") || !prefix.startsWith("/"))) return suggestions;
  let changed = false;
  const items = suggestions.items.map((item) => {
    if (!isWorkspaceRow(item)) return item;
    if (item.description === description) return item;
    changed = true;
    return { ...item, description };
  });
  if (!changed) return suggestions;
  return { ...suggestions, items };
}

/**
 * Build the provider wrapper. `getDescription` is called for every completion,
 * so a workspace switch is visible on the next `/` without rebuilding anything.
 */
export function createWorkspaceRowProvider(getDescription) {
  return (provider) => {
    if (!provider || typeof provider.getSuggestions !== "function") return provider;
    const wrapper = {
      getSuggestions(lines, cursorLine, cursorCol, options) {
        const base = provider.getSuggestions.call(provider, lines, cursorLine, cursorCol, options);
        return Promise.resolve(base).then((suggestions) => {
          let description = "";
          try {
            description = typeof getDescription === "function" ? getDescription() : "";
          } catch {
            description = "";
          }
          return patchWorkspaceRow(suggestions, description);
        });
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return provider.applyCompletion.call(provider, lines, cursorLine, cursorCol, item, prefix);
      },
    };
    if (typeof provider.shouldTriggerFileCompletion === "function") {
      wrapper.shouldTriggerFileCompletion = (...args) => provider.shouldTriggerFileCompletion.apply(provider, args);
    }
    if (provider.triggerCharacters) {
      wrapper.triggerCharacters = provider.triggerCharacters;
    }
    return wrapper;
  };
}