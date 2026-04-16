$ErrorActionPreference = "Stop"

$taskName = "NextGenChat"
$mode = if ($args.Length -gt 0) { $args[0] } else { "disable" }

switch ($mode) {
    "disable" {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Write-Host "Stopped and disabled Windows Scheduled Task '$taskName'." -ForegroundColor Green
    }
    "remove" {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Stopped, disabled, and removed Windows Scheduled Task '$taskName'." -ForegroundColor Green
    }
    default {
        Write-Error "Usage: powershell -ExecutionPolicy Bypass -File scripts/service-disable.ps1 [disable|remove]"
        exit 1
    }
}
