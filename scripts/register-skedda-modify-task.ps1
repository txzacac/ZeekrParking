param(
  [string]$TriggerTime = "09:30"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$taskName = "SkeddaParkingModify"
$scriptPath = Join-Path $repoRoot "scripts\skedda-modify-booking.mjs"
$runnerPath = Join-Path $repoRoot "scripts\run-skedda-modify.ps1"
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path $scriptPath)) {
  throw "Could not find $scriptPath"
}
if (-not (Test-Path $runnerPath)) {
  throw "Could not find $runnerPath"
}

$actionArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerPath`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $actionArguments -WorkingDirectory $repoRoot
$triggerAt = [datetime]::ParseExact($TriggerTime, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$trigger = New-ScheduledTaskTrigger -Daily -At $triggerAt
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -WakeToRun `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Modify tomorrow's Zeekr Skedda parking booking. Trigger time is $TriggerTime; target booking time is configured in .env." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $taskName"
Write-Host "Runs daily at $TriggerTime from: $repoRoot"
Write-Host "Before relying on it, run: npm run skedda:login"
