// Windows' own "browse for folder" dialog, with no runtime dependency.
//
// The dialog is the one Windows ships: .NET WinForms `FolderBrowserDialog`,
// driven by a short PowerShell program. `pwsh` (PowerShell 7, .NET 6+ WinForms)
// shows the Explorer-style common item dialog; Windows PowerShell 5.1 (.NET
// Framework) shows the classic folder dialog and is only the fallback.
//
// Three rules make the hand-off safe and predictable:
//
//  * the folder name never reaches a command line. The starting directory
//    travels in `input.json` beside the script and is read with
//    `Get-Content -LiteralPath`, so spaces, quotes, `$`, `%`, Chinese and
//    `\\server\share` are data, never PowerShell syntax;
//  * the answer comes back through `result.json`, written by .NET as BOM-less
//    UTF-8, so the console code page never touches a path character;
//  * the child is a plain spawn with a timeout and no shell, so a dialog the
//    user leaves open is closed instead of hanging the command.
//
// The caller gets one of
//   { ok: true, path }
//   { ok: false, cancelled: true }
//   { ok: false, available: false, message }        no Windows/WinForms/shell
//   { ok: false, available: true, code, message }   the dialog failed
// and decides what to do; nothing here validates the directory itself.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const PICKER_SCRIPT_NAME = "pick-folder.ps1";
export const PICKER_INPUT_NAME = "input.json";
export const PICKER_RESULT_NAME = "result.json";
export const PICKER_SHELLS = ["pwsh.exe", "powershell.exe"];
export const PICKER_TIMEOUT_MS = 300000;
export const PICKER_DESCRIPTION = "Select the workspace folder for Pi.";

/**
 * The PowerShell program. Kept ASCII-only on purpose: Windows PowerShell 5.1
 * reads a script file as the ANSI code page unless it has a BOM, and every
 * value this script needs arrives as UTF-8 JSON rather than as source text.
 */
export const PICKER_SCRIPT = `# pi-change-workspace: Windows' own folder browser dialog.
#
# Input   : input.json beside this file  ({ initial, description })
# Output  : result.json beside this file
#           { cancelled: true }
#           { cancelled: false, path: "<absolute directory>" }
#           { error: "<message>", stage: "assembly" | "dialog" }
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$inFile = Join-Path -Path $root -ChildPath 'input.json'
$outFile = Join-Path -Path $root -ChildPath 'result.json'
$settings = $null

function Write-PickerResult([hashtable]$payload) {
  $json = $payload | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($outFile, $json, [System.Text.UTF8Encoding]::new($false))
}

try {
  $settings = Get-Content -LiteralPath $inFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  $settings = $null
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-PickerResult @{ error = ('System.Windows.Forms: ' + $_.Exception.Message); stage = 'assembly' }
  exit 3
}

$dialog = $null
$owner = $null
try {
  try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  # AutoUpgradeEnabled is the Explorer-style (Vista+) common item dialog instead
  # of the legacy tree. It exists in .NET 6+ WinForms (PowerShell 7); .NET
  # Framework (Windows PowerShell 5.1) does not have it, and there the classic
  # folder dialog is still the right thing to show.
  try { $dialog.AutoUpgradeEnabled = $true } catch { }
  try { $dialog.UseDescriptionForTitle = $true } catch { }
  $dialog.ShowNewFolderButton = $true
  if ($null -ne $settings -and -not [string]::IsNullOrEmpty($settings.description)) {
    $dialog.Description = [string]$settings.description
  }
  if ($null -ne $settings -and -not [string]::IsNullOrEmpty($settings.initial)) {
    $start = [string]$settings.initial
    try {
      if (Test-Path -LiteralPath $start -PathType Container) { $dialog.SelectedPath = $start }
    } catch { }
  }

  # A tiny, invisible, topmost owner form keeps the dialog in front of the
  # terminal window instead of behind it. If it cannot be created the dialog is
  # still shown, just without an owner.
  try {
    $owner = New-Object System.Windows.Forms.Form
    $owner.Text = 'pi-change-workspace'
    $owner.ShowInTaskbar = $false
    $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $owner.Size = [System.Drawing.Size]::new(1, 1)
    $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $owner.TopMost = $true
    $owner.Opacity = 0
    $owner.Show()
  } catch {
    if ($owner) { try { $owner.Dispose() } catch { } }
    $owner = $null
  }

  if ($owner) { $result = $dialog.ShowDialog($owner) } else { $result = $dialog.ShowDialog() }

  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $picked = [string]$dialog.SelectedPath
    if ([string]::IsNullOrWhiteSpace($picked)) {
      Write-PickerResult @{ cancelled = $true }
    } else {
      Write-PickerResult @{ cancelled = $false; path = [System.IO.Path]::GetFullPath($picked) }
    }
  } else {
    Write-PickerResult @{ cancelled = $true }
  }
} catch {
  Write-PickerResult @{ error = $_.Exception.Message; stage = 'dialog' }
  exit 4
} finally {
  if ($owner) { try { $owner.Close() } catch { }; try { $owner.Dispose() } catch { } }
  if ($dialog) { try { $dialog.Dispose() } catch { } }
}
exit 0
`;

function outcome({ ok, available = true, cancelled = false, code = null, message = "", ...rest }) {
  return { ok, available, cancelled, code, message, ...rest };
}

function unavailable(message) {
  return outcome({ ok: false, available: false, code: "PICKER_UNAVAILABLE", message });
}

function failure(message, code = "PICKER_FAILED", extra = {}) {
  return outcome({ ok: false, available: true, code, message, ...extra });
}

function firstLine(text, limit = 300) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.slice(0, limit) : "";
}

/** The exact bytes written for the dialog's input file. Paths stay data. */
export function buildPickerInput({ initial = "", description = PICKER_DESCRIPTION } = {}) {
  return `${JSON.stringify({ initial: String(initial ?? ""), description: String(description ?? "") })}\n`;
}

export function readPickerPayload(path) {
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A path the dialog could legitimately return: absolute, printable, non-empty. */
export function isUsablePickedPath(value) {
  return typeof value === "string" && isAbsolute(value) && !/[\u0000-\u001f]/.test(value);
}

/**
 * Turn one finished shell run into a picker outcome. Pure, so every branch
 * (cancel, dialog error, missing WinForms, exit code, timeout, no result) is
 * testable without opening a window.
 *
 * `next: "shell"` means this shell could not be started at all and the caller
 * may try the next one; a real dialog result, a cancel or an error is final.
 */
export function interpretPickerRun({ payload = null, exitCode = null, stderr = "", killed = false, code = null, shell = "" } = {}) {
  const detail = firstLine(stderr);
  if (killed) {
    return { ...failure("The folder dialog timed out and closed. Workspace unchanged.", "PICKER_TIMEOUT"), next: "return" };
  }
  if (!payload && /ENOENT|not recognized|not found|is not recognized/i.test(detail)) {
    return { next: "shell", code, shell, detail };
  }
  if (payload?.error) {
    const message = String(payload.error).slice(0, 300);
    if (payload.stage === "assembly") {
      return { ...unavailable(`The folder dialog is unavailable (${message}). Type the folder path.`), next: "return" };
    }
    return { ...failure(`The folder dialog failed (${message}). Workspace unchanged.`, "PICKER_DIALOG_FAILED"), next: "return" };
  }
  if (exitCode !== null && exitCode !== 0) {
    return {
      ...failure(
        `The folder dialog failed (exit code ${exitCode})${detail ? `. ${detail}` : ""}. Workspace unchanged.`,
        "PICKER_EXIT_CODE",
      ),
      next: "return",
    };
  }
  if (!payload) {
    return {
      ...failure(
        `The folder dialog returned no result${exitCode === null ? "" : ` (exit code ${exitCode})`}${detail ? `. ${detail}` : ""}. Workspace unchanged.`,
        "PICKER_NO_RESULT",
      ),
      next: "return",
    };
  }
  if (payload.cancelled === true) {
    return {
      ...outcome({ ok: false, available: true, cancelled: true, code: "PICKER_CANCELLED", message: "Canceled. Workspace unchanged." }),
      next: "return",
    };
  }
  const path = payload.path;
  if (!isUsablePickedPath(path)) {
    return {
      ...failure(
        `The folder dialog returned an invalid path (${JSON.stringify(payload.path ?? null)}). Workspace unchanged.`,
        "PICKER_INVALID_PATH",
      ),
      next: "return",
    };
  }
  return {
    ...outcome({ ok: true, available: true, cancelled: false, code: null, message: "", path }),
    next: "return",
  };
}

/** Remove the temporary directory; Windows may still hold a file for a moment. */
async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === 3) return false; // best effort; a temp directory is not a failure
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  return false;
}

/** The shells to try, in order: an override wins, otherwise PowerShell 7 then 5.1. */
export function shellCandidates(env = process.env, shell = "") {
  const override = String(shell || env?.PI_CHANGE_WORKSPACE_PICKER_SHELL || "").trim();
  return override ? [override] : [...PICKER_SHELLS];
}

function runShell(exe, args, { timeoutMs, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(exe, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    let stderr = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    child.on?.("error", (error) => finish({ error }));
    child.stderr?.on?.("data", (chunk) => {
      if (stderr.length < 8000) stderr += chunk.toString("utf8");
    });
    child.on?.("close", (code, signal) => finish({ code, signal, killed: child.killed === true || signal === "SIGTERM", stderr }));
  });
}

/**
 * Show the native folder picker and return the user's choice.
 *
 * There is no shell: the script path is the only argument that is not a fixed
 * flag, and the starting directory is passed as file data.
 */
export async function pickFolder(options = {}) {
  const {
    initialDir = "",
    description = PICKER_DESCRIPTION,
    timeoutMs = PICKER_TIMEOUT_MS,
    platform = process.platform,
    env = process.env,
    shell = "",
    tempRoot = tmpdir(),
    spawnImpl = spawn,
  } = options;

  if (platform !== "win32") {
    return unavailable("The folder dialog needs Windows. Type the folder path.");
  }
  const started = performance.now();
  const shells = shellCandidates(env, shell);
  let dir = "";
  try {
    dir = mkdtempSync(join(tempRoot, "pi-change-workspace-"));
    const scriptPath = join(dir, PICKER_SCRIPT_NAME);
    const resultPath = join(dir, PICKER_RESULT_NAME);
    writeFileSync(scriptPath, PICKER_SCRIPT, "utf8");
    writeFileSync(join(dir, PICKER_INPUT_NAME), buildPickerInput({ initial: initialDir, description }), "utf8");
    const args = ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath];

    const tried = [];
    for (const shellExe of shells) {
      const run = await runShell(shellExe, args, { timeoutMs, spawnImpl });
      if (run.error) {
        if (run.error.code === "ENOENT") {
          tried.push(`${shellExe}: not found`);
          continue;
        }
        return failure(`Could not start the folder dialog (${firstLine(run.error.message, 120) || run.error.code}). Workspace unchanged.`, "PICKER_SPAWN_FAILED");
      }
      const verdict = interpretPickerRun({
        payload: readPickerPayload(resultPath),
        exitCode: Number.isInteger(run.code) ? run.code : null,
        stderr: run.stderr,
        killed: run.killed === true,
        code: run.code,
        shell: shellExe,
      });
      if (verdict.next === "shell") {
        tried.push(`${shellExe}: ${verdict.detail || "could not be started"}`);
        continue;
      }
      const final = { ...verdict, shell: shellExe, exitCode: Number.isInteger(run.code) ? run.code : null };
      delete final.next;
      final.durationMs = Math.round(performance.now() - started);
      return final;
    }

    return unavailable(`The folder dialog is unavailable (${tried.join("; ") || shells.join(", ")}). Type the folder path.`);
  } catch (error) {
    return failure(`The folder dialog failed (${firstLine(error?.message || error, 160)}). Workspace unchanged.`, "PICKER_FAILED");
  } finally {
    if (dir) await cleanupDir(dir);
  }
}
