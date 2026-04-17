$ErrorActionPreference = "Stop"

$repoUrl = if ($env:NEXTGENCHAT_REPO_URL) { $env:NEXTGENCHAT_REPO_URL } else { "https://github.com/AmmarAlasad/NextGenChat.git" }
$installDir = if ($env:NEXTGENCHAT_DIR) { $env:NEXTGENCHAT_DIR } else { Join-Path $env:USERPROFILE "NextGenChat" }
$logsDir = Join-Path $env:LOCALAPPDATA "NextGenChat\logs"

function Invoke-GitCommand {
    param([string[]]$Arguments)

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & git @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        $output | ForEach-Object { Write-Host $_ }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $exitCode"
    }
}

function Ensure-Repo {
    if ((Test-Path "package.json") -and (Test-Path "scripts/setup.ps1") -and (Test-Path ".git")) {
        return (Get-Location).Path
    }

    if (-not (Test-Path (Join-Path $installDir ".git"))) {
        Invoke-GitCommand -Arguments @("clone", $repoUrl, $installDir)
    } else {
        Invoke-GitCommand -Arguments @("-C", $installDir, "pull", "--ff-only")
    }

    return $installDir
}

function Stop-ExistingNextGenChat {
    $task = Get-ScheduledTask -TaskName "NextGenChat" -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName "NextGenChat" -ErrorAction SilentlyContinue

        $deadline = (Get-Date).AddSeconds(20)
        do {
            Start-Sleep -Seconds 1
            $task = Get-ScheduledTask -TaskName "NextGenChat" -ErrorAction SilentlyContinue
        } while ($task -and $task.State -eq "Running" -and (Get-Date) -lt $deadline)
    }

    $portOwners = Get-NetTCPConnection -LocalPort 3000,3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $portOwners) {
        if ($processId -and $processId -ne $PID) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Wait-NextGenChatStartup {
    param([int]$TimeoutSeconds = 90)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $frontendReady = $false
        $backendReady = $false

        try {
            $frontendResponse = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 5
            $frontendReady = $frontendResponse.StatusCode -ge 200
        } catch {}

        try {
            $backendResponse = Invoke-WebRequest -Uri "http://localhost:3001/health" -UseBasicParsing -TimeoutSec 5
            $backendReady = $backendResponse.StatusCode -ge 200
        } catch {}

        if ($frontendReady -and $backendReady) {
            return $true
        }

        Start-Sleep -Seconds 3
    }

    return $false
}

function Invoke-NativeLogged {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$LogPath,
        [string]$WorkingDirectory = $repoDir
    )

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

    $stdoutLog = "$LogPath.stdout"
    $stderrLog = "$LogPath.stderr"

    try {
        $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        $exitCode = $process.ExitCode

        $output = @()
        if (Test-Path -LiteralPath $stdoutLog) { $output += Get-Content -Path $stdoutLog -Encoding UTF8 }
        if (Test-Path -LiteralPath $stderrLog) { $output += Get-Content -Path $stderrLog -Encoding UTF8 }
        $output | Set-Content -Path $LogPath -Encoding UTF8
        $output | ForEach-Object { Write-Host $_ }
    }
    finally {
        Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
    }

    if ($exitCode -ne 0) {
        throw "Command failed with exit code $exitCode. See $LogPath"
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git is required"
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 20+ is required"
    exit 1
}

$repoDir = Ensure-Repo
Set-Location $repoDir
. (Join-Path $repoDir "scripts/windows-pnpm.ps1")

Stop-ExistingNextGenChat

& powershell -ExecutionPolicy Bypass -File "scripts/setup.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "NextGenChat Windows setup failed with exit code $LASTEXITCODE"
}

$pnpmPath = Get-PnpmPath
if (-not $pnpmPath) {
    throw "pnpm is unavailable after setup. Re-run the installer from a new PowerShell window or check $logsDir."
}
Invoke-NativeLogged -FilePath $pnpmPath -Arguments @("build") -LogPath (Join-Path $logsDir "build.log")

& powershell -ExecutionPolicy Bypass -File "scripts/service-install.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "NextGenChat Windows service installation failed with exit code $LASTEXITCODE"
}

if (-not (Wait-NextGenChatStartup)) {
    $taskInfo = Get-ScheduledTaskInfo -TaskName "NextGenChat" -ErrorAction SilentlyContinue
    $lastResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { "unknown" }
    & schtasks /Query /TN NextGenChat /V /FO LIST | Out-Host
    throw "NextGenChat was installed, but startup failed. Scheduled Task LastTaskResult=$lastResult. Check logs under $logsDir"
}

Write-Host ""
Write-Host "NextGenChat is running." -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000"
Write-Host "Backend:  http://localhost:3001"
Write-Host "Logs:     $logsDir"
Write-Host "Task:     $env:WINDIR\System32\schtasks.exe /Query /TN NextGenChat"
