// pi-change-workspace: `/workspace` for the native Windows Pi CLI.
//
// Pick a folder and Pi continues in a fresh, blank session whose runtime cwd is
// that folder — same process, same TUI, no restart. Pi itself is the thing that
// rebuilds the runtime (project context files, skills, built-in tool paths) from
// the new session's header `cwd`.
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { pickFolder } from "../src/picker.js";
import { registerWorkspaceCommands } from "../src/register.js";

export default function workspaceExtension(pi) {
  return registerWorkspaceCommands(pi, { SessionManager, pickFolder });
}