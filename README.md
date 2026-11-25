# pi-change-workspace

`/workspace` for the native Windows Pi CLI: choose a folder with Windows' own
folder dialog, and the running Pi continues in a **fresh, blank session for that
folder** — same process, same TUI, no restart, no `/resume` dance, no history
copied.

```
pi (started in the wrong directory)
  /            → pick /workspace
               → native folder dialog opens at the current session cwd
               → choose D:\projects\app
  Pi replaces its session in place: cwd, AGENTS.md/project context, skills and
  built-in tool paths now belong to D:\projects\app, in a new empty conversation.
  The old conversation is still on disk and still resumable with /resume.
```

Scope is deliberately small: native Windows interactive CLI only. There is no
T3/GUI integration, no remote or WSL picker, no session-recall feature, and no
second command or argument mode.

## Install

Nothing has to be copied into Pi or vendored anywhere: Pi loads the package
straight from its source. Either the GitHub source (no clone on your disk) or a
local clone when you are developing it.

### From GitHub

Try it for one run:

```bat
pi -e git:github.com/naixujingjjj/pi-change-workspace
```

Install it once to get `/workspace` in every session:

```bat
pi install git:github.com/naixujingjjj/pi-change-workspace
```

Both are the same source; Pi clones it into its own directory, so neither Pi's
installation nor this README depends on a folder of yours. A plain URL is
accepted as a git source too:

```bat
pi install https://github.com/naixujingjjj/pi-change-workspace
```

Pin a tag, branch or commit when you want a fixed version:

```bat
pi install git:github.com/naixujingjjj/pi-change-workspace@v0.1.0
```

Afterwards `pi list` shows it, `pi remove <source>` removes it, and
`pi update --extensions` reconciles it. A git source that is not pinned to a tag
or commit is re-fetched on start and `/reload`; `-e` runs are cached under
`~/.pi/agent/tmp/extensions/`. Declarations are written by `pi install` into
Pi's own settings — this package never writes settings, models, auth or trust
state.

### From a local clone (development)

```bat
git clone https://github.com/naixujingjjj/pi-change-workspace.git
cd pi-change-workspace
pi -e .                          :: load the package for this run only
pi -e extensions\workspace.js    :: or just the single extension file
pi install .                     :: or register it for every session
```

A local package is loaded from its resolved path without copying, so your edits
apply after `/reload`. If you register a local path from `settings.json`, prefer
an absolute one: relative local paths resolve from the settings file that
contains them, not from the directory you happen to run Pi in.

Requirements:

- Windows. The dialog uses .NET WinForms through `pwsh.exe` (PowerShell 7,
  Explorer-style dialog) with `powershell.exe` (Windows PowerShell 5.1, classic
  folder dialog) as the fallback.
- Pi 1.6.0 was used to build and verify this package; it needs Pi's session
  replacement API (`ctx.switchSession`, `SessionManager`) which this version
  provides.
- Node 22 or newer (Pi's own requirement).

## Use

Type `/` and choose `/workspace`. The slash row's description is the current
workspace's native absolute path (`D:\projects\app`), and it refreshes after a
successful switch.

What each outcome does:

| Situation | Result |
| --- | --- |
| Folder chosen, different from the current one | New blank session with that `cwd`, in this process. Notification: `Workspace: <path>`. |
| Dialog cancelled / Esc | Nothing happens. `Canceled. Workspace unchanged.` |
| Same folder (case, trailing separators and short paths are normalized) | No-op: `Already in <path>`. |
| Path no longer exists / is a file / access denied | One short error, e.g. `Folder not found: <path>`. Workspace unchanged. |
| A response is streaming or input is queued | One confirmation first, because Pi tears the old runtime down. Confirming aborts the response and drops the queued input; this session stays resumable. |
| Another extension vetoes the switch (`session_before_switch`) | `Workspace switch canceled.` The unused new session file is removed; the source session is untouched. |
| Pi switched but the new session could not be built | Short error. The source session is untouched. |
| `/workspace` invoked again while it is still running | `Workspace is already running.` One switch at a time. |
| `/workspace <anything>` | `Usage: /workspace takes no arguments.` |
| Pi started with `--no-session` | Refused up front: `Workspace switching needs saved sessions. Start Pi without --no-session.` |

The new conversation is genuinely empty: no summary, no marker message, no
restored history. Nothing is written into the old session transcript. Old
conversations show up in `/resume` exactly as before, under the project folder
they belong to.

## The folder dialog

- Windows' own dialog, started as a normal child process with no shell:
  `pwsh.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File <temp script>`.
- The starting directory and the answer travel through `input.json` and
  `result.json` (UTF-8, BOM-less) in a temporary directory. No path is ever
  interpolated into PowerShell source, so spaces, quotes, `$`, `%`, `&`,
  brackets, Chinese names and `\\server\share` paths stay data.
- A cancel is a cancel; a timeout (5 minutes), an exit code, a missing result or
  a broken WinForms assembly is reported as an error.
- The temporary directory is removed afterwards, best effort.
- `PI_CHANGE_WORKSPACE_PICKER_SHELL` overrides which PowerShell executable is
  tried (`PI_CHANGE_WORKSPACE_PICKER_SHELL=C:\Program Files\PowerShell\7\pwsh.exe`).

### Fallbacks

- The dialog is used only in the interactive TUI. In RPC/headless mode (and
  whenever the dialog is unavailable on this machine) the command asks for the
  path in one text prompt instead, starting from the current session cwd. That
  is also how automation drives it.
- If the dialog fails mid-flight, the error is shown and the typed path prompt
  is offered, so the command still works without WinForms.

## How it works (and why)

1. **Pick.** The dialog returns an absolute path as-is. For typed input, Pi
   trims surrounding whitespace and one pair of quotes, expands `~`, and
   resolves relative paths against the session cwd.
2. **Verify.** `fs.realpathSync.native` + a directory check give the canonical
   Windows spelling (long path, junctions and case resolved). An invalid target
   never reaches the session machinery.
3. **No-op check.** `samePath()` compares case-insensitively with trailing
   separators ignored, so `F:\work` and `f:\WORK\` are the same workspace.
4. **Fresh session.** `SessionManager.create(targetCwd[, sessionDir])` computes
   Pi's own session id, file name and header (`type`, `version`, `id`,
   `timestamp`, `cwd`). Pi is lazy and writes that file only when the first
   user/assistant message arrives, so this package writes exactly that one
   header line with the exclusive `wx` flag — a pre-existing file is never
   overwritten. A header-only file is a valid Pi session: `SessionManager.open`
   loads it, reports the target `cwd` and zero entries.
5. **Replace.** `ctx.switchSession(sessionFile, { withSession })`. Pi rebuilds the
   runtime from the target session's header `cwd`; `withSession` runs after the
   old session was shut down and the new one is bound, and reports
   `Workspace: <path>` there. (`ctx.newSession()` has no cwd option, and
   `process.chdir` is never used: neither would rebuild Pi's services.)
6. **Refresh.** The new extension instance receives `session_start` with the new
   cwd, and `withSession` updates the same value, so the `/workspace`
   autocomplete row shows the new path immediately.

Session storage:

- Default: the target project's own session directory
  (`<agent dir>/sessions/--<encoded target cwd>--`), so the new session is
  listed under the folder it belongs to. The old session stays where it was.
- Explicit storage (`--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, the
  `sessionDir` setting, or a `--session`/`--continue` file outside the current
  project's default directory) is preserved: the new session is written to that
  same directory, with the target cwd in its header. This matches what Pi's own
  `/new` does with `SessionManager.getSessionDir()`. The decision uses Pi's own
  `SessionManager.usesDefaultSessionDir()` when the host exposes it, so no
  unused default directory is created just to compare paths.

Project trust is Pi's, untouched: switching into a folder with project resources
goes through Pi's normal trust handling on the replacement runtime. This package
never writes trust state, settings, models or auth.

### Caveats that cannot be avoided

- The target session file is materialized by writing Pi's own header object
  (obtained from `SessionManager.create`) with `wx`. Pi's public API has no
  "flush the empty session" call, and `ctx.switchSession` requires an existing
  file whose header carries the target `cwd`.
- A switch that fails **after** Pi already replaced the runtime is
  indistinguishable from one that failed before, so the unused header-only file
  is removed only when the still-readable old context still reports the old
  session file. Otherwise the file is left in place and reported
  (`Left unused session file: <path>`); the old context throws once Pi has
  replaced the runtime, which is the signal used.
- The extension is plain JavaScript with one static import from
  `@earendil-works/pi-coding-agent`, resolved by Pi's own module mapping (no
  bundled copy, no dependency installation).

## Verify it yourself

```bat
cd pi-change-workspace          :: the clone you are working in
npm run lint:syntax
npm test                     :: unit tests + the real-Pi integration test
npm run test:unit
npm run test:integration     :: spawns the installed pi CLI in RPC mode
npm run test:acceptance      :: the same real-Pi checks, driven from PowerShell
```

`npm test` runs each test file separately so its Pi configuration stays
isolated. Test fixtures live under `.tmp/` (git-ignored). Unit and Node
integration tests remove their fixtures. The PowerShell acceptance script
keeps each run's fixtures in a separate directory there for inspection.

What the automated tests cover:

- `test/target-path.test.mjs` — empty/whitespace, control characters, missing
  paths, files, relative paths, Unicode/spaces/quotes/`$`/`%`/`#`/brackets,
  trailing and duplicate separators, `~`, and Windows case-insensitive same-path
  comparison.
- `test/picker.test.mjs` — the dialog's input/output files, "path is data, never
  source", BOM-less UTF-8, cancel vs. error, missing WinForms, exit codes,
  timeouts, pwsh → Windows PowerShell fallback, invalid returned paths, spawn
  failure, temp-directory cleanup. The GUI is never opened.
- `test/session-target.test.mjs` — the header-only session really is a valid Pi
  session (opened through the installed `SessionManager`), target cwd in the
  header, target-project storage, explicit storage preserved, `--no-session`
  refusal, no overwrite on collision, ownership-checked cleanup, source session
  untouched.
- `test/command.test.mjs` — success, cancel, same-directory no-op, dialog
  unavailable → typed path, invalid path, busy/queued confirmation, no
  confirmation available, veto, failed switch with cleanup, uncertain outcome
  left in place, `--no-session`, non-TUI host, arguments, planning failure, one
  invocation at a time, source untouched on every failure path.
- `test/register.test.mjs` — one `/workspace` command, autocomplete override
  installed only in the TUI, tolerant of hosts without that hook, and the row
  refreshing after a switch.
- `test/autocomplete.test.mjs` — **real** `CombinedAutocompleteProvider` output
  from the installed `@earendil-works/pi-tui`: before the wrapper the row carries
  Pi's `[u] ` origin tag, after it the row is exactly the native absolute path,
  look-alike rows (`/workspace-extra`, `help`) are byte-identical, the base
  provider is not mutated, and the row refreshes when the path changes.
- `test/entry.test.mjs` — the entry's wiring (needs the installed package to be
  linkable into `node_modules`; otherwise skipped, and the integration test
  covers the entry instead).
- `test/pi-integration.test.mjs` — the real thing: starts the installed
  `pi 1.6.0` CLI in RPC mode with this extension, a probe fixture and a real
  session file, then checks cancel, same-path no-op, invalid path, an actual
  switch (new session id, blank conversation, header `cwd`, session file under
  the target project's storage, old session byte-identical afterwards),
  rebuilt runtime (`ctx.cwd`, prompt cwd, target `AGENTS.md` loaded, previous
  project's context gone, and Pi's own built-in `read` tool resolving the
  relative path `AGENTS.md` to the target), plus a second run where another
  extension vetoes the switch (session unchanged, no stray session file). No
  model calls.

Known limits of the automated coverage:

- The native dialog itself is not clicked automatically (it is a real Windows
  window). Its control flow, parsing and failure handling are unit-tested with a
  scripted stand-in for `spawn`, and the real spawn path is covered only when the
  test process may start children.
- `test/pi-integration.test.mjs` skips itself when child processes are not
  allowed (for example inside a restricted sandbox). `tools/acceptance-rpc.ps1`
  (`npm run test:acceptance`) drives the same real-Pi flow from PowerShell, which
  is what was run to verify this package where the Node test process could not
  spawn `pi`; it checks cancel, same-folder no-op, a missing folder, the real
  switch (new session id, blank conversation, header cwd, target-project
  storage, old session byte-identical), the rebuilt runtime (`ctx.cwd`, prompt
  cwd, target `AGENTS.md`, no previous context, built-in `read` resolving
  `AGENTS.md` relatively), and a vetoed switch (session unchanged, no stray
  session file). Exit code 0 means every check passed.
- `test/entry.test.mjs` skips when Windows refuses to create the directory link
  that lets a plain Node test resolve `@earendil-works/pi-coding-agent`
  (Developer Mode or an elevated shell normally allows it).
- The interactive pieces that cannot be automated here — the WinForms dialog
  window being shown, and the `/` menu actually painting the path on the right —
  are covered by the manual steps below; the autocomplete row is verified
  against the real `@earendil-works/pi-tui` provider output.

### Manual acceptance (interactive)

1. Open CMD in some other folder and start Pi with
   `pi -e git:github.com/naixujingjjj/pi-change-workspace`.
2. Type `/`, confirm the `/workspace` row shows that folder's absolute path and
   nothing else.
3. Send `/workspace`. The dialog opens in the current folder.
4. Cancel it → no new session, no transcript change.
5. `/workspace` again, pick the same folder → `Already in <path>`.
6. `/workspace` again, pick a different project folder that has its own
   `AGENTS.md` → the dialog closes, the next `/` row shows the new path, and the
   conversation is empty in the same terminal window. `read AGENTS.md` (or ask
   the model) now sees the new project's rules, and relative tool paths resolve
   there.
7. `/resume` still lists (and can open) the old conversation.
8. Start a long response, then `/workspace`: it asks before interrupting.

## Files

```
extensions/workspace.js   Pi entry: imports SessionManager, registers the command
src/register.js           wiring: command + live autocomplete row
src/command.js            /workspace flow: pick → verify → plan → switch → report
src/picker.js             Windows folder dialog (pwsh / Windows PowerShell)
src/target-path.js        canonicalization and case-insensitive path comparison
src/session-target.js     fresh header-only session and ownership-checked cleanup
src/autocomplete.js       the `/workspace` row override (path only)
test/…                    unit, provider and real-Pi integration tests
tools/check-syntax.mjs    `node --check` over every ship/test file
tools/acceptance-rpc.ps1 real-Pi acceptance run driven from PowerShell
```

## License

MIT.
