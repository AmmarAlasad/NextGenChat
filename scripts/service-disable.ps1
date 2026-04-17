param(
    [ValidateSet("stop", "disable", "remove")]
    [string]$Mode,
    [switch]$RemoveData,
    [switch]$KeepData
)

$ErrorActionPreference = "Stop"

$taskName = "NextGenChat"
$mode = if ($Mode) { $Mode } elseif ($args.Length -gt 0) { $args[0] } else { "disable" }
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

function Confirm-RemoveData {
    if ($RemoveData) { return $true }
    if ($KeepData) { return $false }

    Write-Host ""
    Write-Host "Local NextGenChat data is stored at:" -ForegroundColor Yellow
    Write-Host "  $runtimeDir" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "This includes conversations, the local database, logs, and agent workspaces." -ForegroundColor Yellow
    $answer = Read-Host "Type DELETE to remove this data, or press Enter to keep it"

    return ($answer -ceq "DELETE")
}

function Remove-NextGenChatData {
    if (Test-Path -LiteralPath $runtimeDir) {
        Remove-Item -LiteralPath $runtimeDir -Recurse -Force
        Write-Host "Removed local NextGenChat data at '$runtimeDir'." -ForegroundColor Green
    } else {
        Write-Host "No local NextGenChat data directory found at '$runtimeDir'." -ForegroundColor Yellow
    }
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
        if (Confirm-RemoveData) {
            Remove-NextGenChatData
        } else {
            Write-Host "Kept local NextGenChat data at '$runtimeDir'." -ForegroundColor Green
        }
        Write-Host "Stopped, disabled, and removed Windows Scheduled Task '$taskName'." -ForegroundColor Green
    }
    default {
        Write-Error "Usage: powershell -ExecutionPolicy Bypass -File scripts/service-disable.ps1 [stop|disable|remove] [-KeepData|-RemoveData]"
        exit 1
    }
}
