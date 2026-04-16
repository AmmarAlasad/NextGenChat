$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path (Join-Path $rootDir "..")).Path
$taskName = "NextGenChat"
$runScript = Join-Path $repoDir "scripts/service-run.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$runScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Run the NextGenChat local stack at user logon." -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Installed and started Windows Scheduled Task '$taskName'." -ForegroundColor Green
