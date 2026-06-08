$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$node = (Get-Command node -ErrorAction Stop).Source
$taskName = "SkeddaParkingCheckIn"
$scriptPath = Join-Path $repoRoot "scripts\skedda-checkin.mjs"
$runnerPath = Join-Path $repoRoot "scripts\run-skedda-checkin.ps1"

if (-not (Test-Path $scriptPath)) {
  throw "Could not find $scriptPath"
}
if (-not (Test-Path $runnerPath)) {
  throw "Could not find $runnerPath"
}

$skipDates = "2026-06-08"
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`" -SkipDates $skipDates" `
  -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -Daily -At 6:35AM
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -WakeToRun `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Check in to today's Zeekr Skedda parking booking at 06:35." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $taskName"
Write-Host "Runs daily at 06:35 from: $repoRoot"
Write-Host "Before relying on it, run: npm run skedda:login"
