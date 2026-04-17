$ErrorActionPreference = "Stop"

$taskName = "NextGenChat"
$mode = if ($args.Length -gt 0) { $args[0] } else { "disable" }
$runtimeDir = Join-Path $env:LOCALAPPDATA "NextGenChat"
$pidFile = Join-Path $runtimeDir "service-pids.json"
$installDir = Join-Path $env:USERPROFILE "NextGenChat"

function Stop-NextGenChatProcesses {
    $processIds = New-Object System.Collections.Generic.List[int]

    if (Test-Path -LiteralPath $pidFile) {
        try {
            $pids = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
            foreach ($name in @("backend", "web", "runner")) {
                $value = $pids.$name
                if ($value) { $processIds.Add([int]$value) }
            }
        }
        catch {}
    }

    $portOwners = Get-NetTCPConnection -LocalPort 3000,3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $portOwners) {
        if ($processId) { $processIds.Add([int]$processId) }
    }

    $matchingProcesses = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and (
            $_.CommandLine -like "*$installDir*" -or
            $_.CommandLine -like "*$runtimeDir*" -or
            $_.CommandLine -like "*@nextgenchat/backend*start*" -or
            $_.CommandLine -like "*@nextgenchat/web*start*"
        )
    }

    foreach ($process in $matchingProcesses) {
        if ($process.ProcessId) { $processIds.Add([int]$process.ProcessId) }
    }

    $processIds |
        Where-Object { $_ -and $_ -ne $PID } |
        Select-Object -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

switch ($mode) {
    "stop" {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Stop-NextGenChatProcesses
        Write-Host "Stopped Windows Scheduled Task '$taskName' and NextGenChat background processes." -ForegroundColor Green
    }
    "disable" {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Stop-NextGenChatProcesses
        Write-Host "Stopped and disabled Windows Scheduled Task '$taskName'." -ForegroundColor Green
    }
    "remove" {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Stop-NextGenChatProcesses
        Write-Host "Stopped, disabled, and removed Windows Scheduled Task '$taskName'." -ForegroundColor Green
    }
    default {
        Write-Error "Usage: powershell -ExecutionPolicy Bypass -File scripts/service-disable.ps1 [stop|disable|remove]"
        exit 1
    }
}
