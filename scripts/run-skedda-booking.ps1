param(
  [switch]$MadMode
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$logDir = Join-Path $repoRoot "logs\skedda"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$stamp = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$taskLog = Join-Path $logDir "$stamp-task-booking.log"
$node = (Get-Command node -ErrorAction Stop).Source
$scriptPath = Join-Path $repoRoot "scripts\skedda-booking.mjs"

if (-not (Test-Path $scriptPath)) {
  throw "Could not find $scriptPath"
}

$env:SKEDDA_KEEP_BROWSER_OPEN = "false"

Push-Location $repoRoot
try {
  "[$(Get-Date -Format o)] Starting Skedda booking task. MadMode=$([bool]$MadMode)" | Out-File -FilePath $taskLog -Encoding utf8
  "Node: $node" | Out-File -FilePath $taskLog -Encoding utf8 -Append
  "Script: $scriptPath" | Out-File -FilePath $taskLog -Encoding utf8 -Append

  $arguments = @($scriptPath)
  if ($MadMode) {
    $arguments += "--mad"
  }

  & $node @arguments *>> $taskLog
  $exitCode = $LASTEXITCODE
  "[$(Get-Date -Format o)] Finished Skedda booking task. ExitCode=$exitCode" | Out-File -FilePath $taskLog -Encoding utf8 -Append
  exit $exitCode
} catch {
  "[$(Get-Date -Format o)] Skedda booking task failed: $($_.Exception.Message)" | Out-File -FilePath $taskLog -Encoding utf8 -Append
  throw
} finally {
  Pop-Location
}
