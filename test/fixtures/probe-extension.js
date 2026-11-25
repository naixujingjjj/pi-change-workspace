// Test fixture: report what the running Pi session believes after a switch.
//
// `/probe` writes one JSON file (path from PI_WORKSPACE_PROBE_OUT) with the
// session cwd, the prompt options Pi would use for the next request (including
// loaded project context files), the active tool selection, and the result of
// running Pi's own built-in `read` tool against a *relative* path. No model is
// involved.
import { writeFileSync } from "node:fs";

import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";

export default function probeExtension(pi) {
  pi.registerCommand("probe", {
    description: "Write this session's cwd, context files and a relative read to PI_WORKSPACE_PROBE_OUT",
    handler: async (_args, ctx) => {
      const options = ctx.getSystemPromptOptions();
      const probe = {
        cwd: ctx.cwd,
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionId: ctx.sessionManager.getSessionId(),
        promptCwd: options.cwd,
        contextFiles: (options.contextFiles || []).map((file) => file.path),
        selectedTools: options.selectedTools,
        entryCount: ctx.sessionManager.getEntries().length,
        entryTypes: ctx.sessionManager.getEntries().map((entry) => entry.type),
        read: null,
      };
      try {
        const tool = createReadToolDefinition(ctx.cwd);
        const result = await tool.execute("probe-read", { path: "AGENTS.md" }, undefined, undefined, ctx);
        const text = (result.content || [])
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        probe.read = { text, isError: result.isError === true };
      } catch (error) {
        probe.read = { error: String(error?.message || error) };
      }
      writeFileSync(process.env.PI_WORKSPACE_PROBE_OUT, `${JSON.stringify(probe, null, 2)}\n`, "utf8");
      ctx.ui.notify("probe done", "info");
    },
  });
}