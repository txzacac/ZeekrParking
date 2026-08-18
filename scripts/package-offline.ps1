param(
  [string]$OutputZip = "$env:USERPROFILE\Desktop\ZeekrParking-offline.zip"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$stagingRoot = Join-Path $env:TEMP "ZeekrParking-offline-package"
$stagingDir = Join-Path $stagingRoot "ZeekrParking"

if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
if (Test-Path -LiteralPath $OutputZip) {
  Remove-Item -LiteralPath $OutputZip -Force
}

New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

$excludeDirs = @(".git", "node_modules", ".skedda-profile", "logs")
$excludeFiles = @(".env")

Get-ChildItem -LiteralPath $repoRoot -Force | ForEach-Object {
  if ($excludeDirs -contains $_.Name -or $excludeFiles -contains $_.Name) {
    return
  }
  Copy-Item -LiteralPath $_.FullName -Destination $stagingDir -Recurse -Force
}

Compress-Archive -Path $stagingDir -DestinationPath $OutputZip -Force

Write-Host "Created package: $OutputZip"
Write-Host "Excluded: $($excludeDirs -join ', '), $($excludeFiles -join ', ')"
