param(
  [switch]$MadMode,
  [string]$PrepareTime = "07:28",
  [string]$RetryTime = "07:31",
  [object]$SundayRetryEnabled = $true,
  [string]$SundayRetryTime = "12:00"
)

$ErrorActionPreference = "Stop"
$SundayRetryIsEnabled = [System.Management.Automation.LanguagePrimitives]::ConvertTo($SundayRetryEnabled, [bool])

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$taskName = "SkeddaParkingBooking"
$scriptPath = Join-Path $repoRoot "scripts\skedda-booking.mjs"
$runnerPath = Join-Path $repoRoot "scripts\run-skedda-booking.ps1"
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path $scriptPath)) {
  throw "Could not find $scriptPath"
}
if (-not (Test-Path $runnerPath)) {
  throw "Could not find $runnerPath"
}

$actionArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerPath`""
if ($MadMode) {
  $actionArguments = "$actionArguments -MadMode"
}
$action = New-ScheduledTaskAction -Execute $powershell -Argument $actionArguments -WorkingDirectory $repoRoot

$prepareAt = [datetime]::ParseExact($PrepareTime, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$retryAt = [datetime]::ParseExact($RetryTime, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$sundayRetryAt = [datetime]::ParseExact($SundayRetryTime, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At $prepareAt),
  (New-ScheduledTaskTrigger -Daily -At $retryAt)
)
if ($SundayRetryIsEnabled) {
  $triggers += New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $sundayRetryAt
}

$modeDescription = if ($MadMode) { "mad parallel tabs, default 3 spaces" } else { "normal" }
$sundayRetryDescription = if ($SundayRetryIsEnabled) { ", and run an extra Sunday $SundayRetryTime retry if the morning did not succeed" } else { "" }
$sundayRetrySummary = if ($SundayRetryIsEnabled) { ", plus Sunday at $SundayRetryTime" } else { "" }
$sundayRetryStatus = if ($SundayRetryIsEnabled) { "enabled at $SundayRetryTime" } else { "disabled" }

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -WakeToRun `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Description "Book Zeekr Skedda parking for the next workday. Mode: $modeDescription. Start at $PrepareTime, retry at $RetryTime$sundayRetryDescription. Actual booking time and space priority are configured in .env." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $taskName"
Write-Host "Runs daily at $PrepareTime and $RetryTime$sundayRetrySummary from: $repoRoot"
Write-Host "Mode: $modeDescription"
Write-Host "Sunday retry: $sundayRetryStatus"
Write-Host "Task runner: $runnerPath"
Write-Host "Before relying on it, run: npm run skedda:login"
