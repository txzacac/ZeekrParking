$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$node = (Get-Command node -ErrorAction Stop).Source
$taskName = "SkeddaParkingBooking"
$scriptPath = Join-Path $repoRoot "scripts\skedda-booking.mjs"

if (-not (Test-Path $scriptPath)) {
  throw "Could not find $scriptPath"
}

$action = New-ScheduledTaskAction `
  -Execute $node `
  -Argument "`"$scriptPath`"" `
  -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -Daily -At 8:00AM
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
  -Description "Book Zeekr Skedda parking for the next workday at 08:00-18:00." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $taskName"
Write-Host "Runs daily at 08:00 from: $repoRoot"
Write-Host "Before relying on it, run: npm run skedda:login"
