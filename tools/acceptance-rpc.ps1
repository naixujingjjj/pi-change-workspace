# Automated acceptance run for pi-change-workspace against the installed Pi CLI.
#
# This drives a real `pi --mode rpc` process the way a client would: it sends
# `/workspace`, answers the path prompt, and then checks the session Pi actually
# switched to. It exists because a Node test runner cannot always start child
# processes (for example inside a restricted sandbox), while PowerShell can.
#
# ASCII only: Windows PowerShell 5.1 reads a script without a BOM as the ANSI
# code page, and every Unicode value here travels through JSON data instead.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\acceptance-rpc.ps1
#
# Exit code 0 means every check passed.
param(
  [string]$Root = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp\acceptance')
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $packageRoot 'extensions\workspace.js'
$probe = Join-Path $packageRoot 'test\fixtures\probe-extension.js'
$vetoExt = Join-Path $packageRoot 'test\fixtures\veto-extension.js'
$piCmd = Join-Path $env:APPDATA 'npm\pi.cmd'

$script:failures = 0
function Assert-True([bool]$condition, [string]$name) {
  if ($condition) {
    Write-Host "PASS  $name"
  } else {
    Write-Host "FAIL  $name"
    $script:failures += 1
  }
}

function Get-Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

function Get-EncodedSessionDir([string]$agentDir, [string]$cwd) {
  $resolved = (Resolve-Path -LiteralPath $cwd).Path
  $safe = '--' + ($resolved -replace '^[/\\]', '' -replace '[/\\:]', '-') + '--'
  return (Join-Path $agentDir "sessions\$safe")
}

if (-not (Test-Path -LiteralPath $piCmd)) {
  Write-Host "SKIP  pi.cmd not found at $piCmd"
  exit 2
}

if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
$agentDir = Join-Path $Root 'agent'
$projectA = Join-Path $Root 'project a'
$projectB = Join-Path $Root "project b 测试 & 'x'"
New-Item -ItemType Directory -Force -Path $agentDir, $projectA, $projectB | Out-Null
[System.IO.File]::WriteAllText((Join-Path $projectA 'AGENTS.md'), "PROJECT A RULES`n", [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $projectB 'AGENTS.md'), "PROJECT B RULES 测试`n", [System.Text.UTF8Encoding]::new($false))

# A real session file for project A: header plus one user message. Pi appends
# its own setup entries while the session is open.
$sessionsA = Get-EncodedSessionDir $agentDir $projectA
New-Item -ItemType Directory -Force -Path $sessionsA | Out-Null
$fixture = Join-Path $sessionsA '2026-01-01T00-00-00-000Z_fixture-id.jsonl'
$header = @{ type = 'session'; version = 3; id = 'fixture-id'; timestamp = '2026-01-01T00:00:00.000Z'; cwd = (Resolve-Path -LiteralPath $projectA).Path } | ConvertTo-Json -Compress
$message = @{ type = 'message'; id = 'm1'; parentId = $null; timestamp = '2026-01-01T00:00:01.000Z'; message = @{ role = 'user'; content = 'OLD SESSION MESSAGE'; timestamp = 1733234400000 } } | ConvertTo-Json -Compress -Depth 6
[System.IO.File]::WriteAllText($fixture, "$header`n$message`n", [System.Text.UTF8Encoding]::new($false))

$realA = (Resolve-Path -LiteralPath $projectA).Path
$realB = (Resolve-Path -LiteralPath $projectB).Path
$probeOut = Join-Path $Root 'probe.json'

function Start-PiRpc([bool]$veto) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $piCmd
  $argList = @('--mode', 'rpc', '-ne', '-e', $entry, '-e', $probe)
  if ($veto) { $argList += @('-e', $vetoExt) }
  $argList += @('--session', $fixture)
  $psi.Arguments = ($argList | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $psi.WorkingDirectory = $realA
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $psi.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
  $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
  $psi.EnvironmentVariables['PI_CODING_AGENT_DIR'] = $agentDir
  $psi.EnvironmentVariables['PI_OFFLINE'] = '1'
  $psi.EnvironmentVariables['PI_SKIP_VERSION_CHECK'] = '1'
  $psi.EnvironmentVariables['PI_TELEMETRY'] = '0'
  $psi.EnvironmentVariables['PI_WORKSPACE_PROBE_OUT'] = $probeOut
  $psi.EnvironmentVariables['PI_WORKSPACE_VETO'] = $(if ($veto) { '1' } else { '0' })
  $process = [System.Diagnostics.Process]::Start($psi)
  return @{ process = $process; stderr = $process.StandardError.ReadToEndAsync(); notes = @() }
}

function Send-Command([hashtable]$pi, [string]$json) {
  $pi.process.StandardInput.WriteLine($json)
  $pi.process.StandardInput.Flush()
}

# Read protocol records until the response with the given id arrives, answering
# the extension's path prompt from $answer or cancelling it. Notifications are
# collected on the pi object.
function Wait-Response([hashtable]$pi, [string]$id, [string]$answer, [bool]$cancelInput, [int]$max = 800) {
  for ($i = 0; $i -lt $max; $i++) {
    $line = $pi.process.StandardOutput.ReadLine()
    if ($null -eq $line) { throw "stdout closed while waiting for $id" }
    if (-not $line.Trim()) { continue }
    $record = $line | ConvertFrom-Json
    if ($record.type -eq 'extension_ui_request') {
      if ($record.method -eq 'notify') {
        $pi.notes += [string]$record.message
        continue
      }
      if ($record.method -eq 'input') {
        if ($cancelInput) {
          Send-Command $pi (@{ type = 'extension_ui_response'; id = $record.id; cancelled = $true } | ConvertTo-Json -Compress)
        } else {
          Send-Command $pi (@{ type = 'extension_ui_response'; id = $record.id; value = $answer } | ConvertTo-Json -Compress)
        }
        continue
      }
      if ($record.method -eq 'confirm') {
        Send-Command $pi (@{ type = 'extension_ui_response'; id = $record.id; confirmed = $true } | ConvertTo-Json -Compress)
        continue
      }
      continue
    }
    if ($record.type -eq 'response' -and $record.id -eq $id) { return $record }
  }
  throw "no response for $id"
}

function Get-State([hashtable]$pi, [string]$id) {
  Send-Command $pi ('{"id":"' + $id + '","type":"get_state"}')
  return (Wait-Response $pi $id '' $false)
}

function Stop-Pi([hashtable]$pi) {
  $pi.process.StandardInput.Close()
  if (-not $pi.process.WaitForExit(20000)) { $pi.process.Kill() }
  return @{ code = $pi.process.ExitCode; stderr = $pi.stderr.Result }
}

# ---------------------------------------------------------------------------
# 1. Normal run: cancel, no-op, invalid path, real switch, rebuilt runtime.
# ---------------------------------------------------------------------------
$pi = Start-PiRpc $false
Start-Sleep -Milliseconds 1500
$stateBefore = Get-State $pi 'state-1'
Assert-True ($stateBefore.data.sessionId -eq 'fixture-id') 'the fixture session is the active session'
Assert-True ($stateBefore.data.messageCount -eq 1) 'the fixture session has its one old message'

Send-Command $pi '{"id":"cmds","type":"get_commands"}'
$commands = Wait-Response $pi 'cmds' '' $false
$workspaceRows = @($commands.data.commands | Where-Object { $_.name -eq 'workspace' })
Assert-True ($workspaceRows.Count -eq 1) '/workspace is registered exactly once'

Send-Command $pi '{"id":"p-cancel","type":"prompt","message":"/workspace"}'
$null = Wait-Response $pi 'p-cancel' '' $true
$state = Get-State $pi 'state-2'
Assert-True (@($pi.notes | Where-Object { $_ -eq 'Canceled. Workspace unchanged.' }).Count -eq 1) 'cancelling the dialog cancels the command'
Assert-True ($state.data.sessionId -eq 'fixture-id') 'cancelling keeps the session'

$pi.notes = @()
Send-Command $pi '{"id":"p-same","type":"prompt","message":"/workspace"}'
$null = Wait-Response $pi 'p-same' ($realA.ToUpper() + '\') $false
$state = Get-State $pi 'state-3'
Assert-True (@($pi.notes | Where-Object { $_ -like 'Already in *' }).Count -eq 1) 'the same folder (case, trailing separator) is a no-op'
Assert-True ($state.data.sessionId -eq 'fixture-id') 'the no-op keeps the session'

$pi.notes = @()
Send-Command $pi '{"id":"p-bad","type":"prompt","message":"/workspace"}'
$null = Wait-Response $pi 'p-bad' (Join-Path $Root 'missing folder') $false
$state = Get-State $pi 'state-4'
Assert-True (@($pi.notes | Where-Object { $_ -like 'Folder not found: *' }).Count -eq 1) 'a missing folder is one short error'
Assert-True ($state.data.sessionId -eq 'fixture-id') 'a missing folder keeps the session'

Start-Sleep -Milliseconds 500
$fixtureHash = Get-Sha256 $fixture
$fixtureLines = [System.IO.File]::ReadAllLines($fixture)

$pi.notes = @()
Send-Command $pi '{"id":"p-switch","type":"prompt","message":"/workspace"}'
$null = Wait-Response $pi 'p-switch' $realB $false
Start-Sleep -Milliseconds 1500
$stateAfter = Get-State $pi 'state-5'
Assert-True (@($pi.notes | Where-Object { $_ -like 'Workspace: *' }).Count -eq 1) 'a successful switch reports the new workspace'
Assert-True ($stateAfter.data.sessionFile -ne $stateBefore.data.sessionFile) 'Pi switched to a different session file'
Assert-True ($stateAfter.data.sessionId -ne 'fixture-id') 'Pi switched to a different session id'
Assert-True ($stateAfter.data.messageCount -eq 0) 'the new session is blank'
Assert-True ($stateAfter.data.sessionFile.ToLower().StartsWith((Get-EncodedSessionDir $agentDir $projectB).ToLower())) 'the new session is stored under the target project'
$newLines = [System.IO.File]::ReadAllLines($stateAfter.data.sessionFile)
$newHeader = $newLines[0] | ConvertFrom-Json
Assert-True ($newHeader.cwd -eq $realB) 'the new session header cwd is the target folder'
Assert-True (-not ([System.IO.File]::ReadAllText($stateAfter.data.sessionFile).Contains('OLD SESSION MESSAGE'))) 'no old messages are copied'
Assert-True ((Get-Sha256 $fixture) -eq $fixtureHash) 'the old session file is unchanged after the switch'
Assert-True ([System.IO.File]::ReadAllLines($fixture).Count -eq $fixtureLines.Count) 'the old session still has its entries'

Send-Command $pi '{"id":"probe","type":"prompt","message":"/probe"}'
$null = Wait-Response $pi 'probe' '' $false
Start-Sleep -Milliseconds 800
Assert-True (Test-Path -LiteralPath $probeOut) 'the probe wrote its report'
if (Test-Path -LiteralPath $probeOut) {
  $report = Get-Content -LiteralPath $probeOut -Raw | ConvertFrom-Json
  Assert-True ($report.cwd -eq $realB) 'ctx.cwd is the target folder'
  Assert-True ($report.promptCwd -eq $realB) 'the system prompt cwd is the target folder'
  Assert-True (@($report.contextFiles | Where-Object { $_ -eq (Join-Path $realB 'AGENTS.md') }).Count -eq 1) 'the target AGENTS.md is loaded'
  Assert-True (@($report.contextFiles | Where-Object { $_ -eq (Join-Path $realA 'AGENTS.md') }).Count -eq 0) 'the previous project context is gone'
  Assert-True ($report.read.text -match 'PROJECT B RULES') 'the built-in read tool resolves a relative path in the target'
  Assert-True ($report.read.isError -eq $false) 'the relative read succeeded'
  Assert-True (-not (@($report.entryTypes) -contains 'message')) 'the new session has no messages'
}
$exit = Stop-Pi $pi
Assert-True ($exit.code -eq 0) 'Pi exited cleanly'

# ---------------------------------------------------------------------------
# 2. Vetoed switch: another extension cancels it; nothing changes.
# ---------------------------------------------------------------------------
$pi = Start-PiRpc $true
Start-Sleep -Milliseconds 1500
$stateVeto = Get-State $pi 'vstate-1'
Assert-True ($stateVeto.data.sessionId -eq 'fixture-id') 'the veto run starts in the fixture session'
Start-Sleep -Milliseconds 500
$vetoHash = Get-Sha256 $fixture
$targetDirB = Get-EncodedSessionDir $agentDir $projectB
$filesBeforeVeto = @(Get-ChildItem -LiteralPath $targetDirB -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$pi.notes = @()
Send-Command $pi '{"id":"p-veto","type":"prompt","message":"/workspace"}'
$null = Wait-Response $pi 'p-veto' $realB $false
$stateVetoAfter = Get-State $pi 'vstate-2'
Assert-True (@($pi.notes | Where-Object { $_ -eq 'Workspace switch canceled.' }).Count -eq 1) 'a vetoed switch is reported as cancelled'
Assert-True ($stateVetoAfter.data.sessionId -eq 'fixture-id') 'a vetoed switch keeps the source session'
Assert-True ((Get-Sha256 $fixture) -eq $vetoHash) 'a vetoed switch leaves the source session file alone'
$filesAfterVeto = @(Get-ChildItem -LiteralPath $targetDirB -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
Assert-True (($filesAfterVeto -join '|') -eq ($filesBeforeVeto -join '|')) 'a vetoed switch removes its unused session file'
$exit = Stop-Pi $pi
Assert-True ($exit.code -eq 0) 'Pi exited cleanly after the veto'

Write-Host ''
if ($script:failures -eq 0) {
  Write-Host 'ACCEPTANCE OK'
  exit 0
}
Write-Host ("ACCEPTANCE FAILED: $($script:failures) check(s)")
exit 1