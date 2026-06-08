param(
  [string]$SkipDates = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$node = (Get-Command node -ErrorAction Stop).Source
$scriptPath = Join-Path $repoRoot "scripts\skedda-checkin.mjs"

if ($SkipDates) {
  $env:SKEDDA_CHECKIN_SKIP_DATES = $SkipDates
}

if ($Force) {
  $env:SKEDDA_CHECKIN_FORCE = "true"
}

Set-Location $repoRoot
& $node $scriptPath
exit $LASTEXITCODE
