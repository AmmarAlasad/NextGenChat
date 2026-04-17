$ErrorActionPreference = "Stop"

$repoUrl = if ($env:NEXTGENCHAT_REPO_URL) { $env:NEXTGENCHAT_REPO_URL } else { "https://github.com/AmmarAlasad/NextGenChat.git" }
$installDir = if ($env:NEXTGENCHAT_DIR) { $env:NEXTGENCHAT_DIR } else { Join-Path $env:USERPROFILE "NextGenChat" }
$logsDir = Join-Path $env:LOCALAPPDATA "NextGenChat\logs"

function Ensure-Repo {
    if ((Test-Path "package.json") -and (Test-Path "scripts/setup.ps1") -and (Test-Path ".git")) {
        return (Get-Location).Path
    }

    if (-not (Test-Path (Join-Path $installDir ".git"))) {
        git clone $repoUrl $installDir | Out-Host
    } else {
        git -C $installDir pull --ff-only | Out-Host
    }

    return $installDir
}

function Wait-NextGenChatStartup {
    param([int]$TimeoutSeconds = 120)

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

& powershell -ExecutionPolicy Bypass -File "scripts/setup.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "NextGenChat Windows setup failed with exit code $LASTEXITCODE"
}

& powershell -ExecutionPolicy Bypass -File "scripts/service-install.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "NextGenChat Windows service installation failed with exit code $LASTEXITCODE"
}

if (-not (Wait-NextGenChatStartup)) {
    $taskInfo = Get-ScheduledTaskInfo -TaskName "NextGenChat" -ErrorAction SilentlyContinue
    $lastResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { "unknown" }
    throw "NextGenChat installed the Windows task but the app did not become healthy. Scheduled Task LastTaskResult=$lastResult. Check logs under $logsDir"
}

Write-Host ""
Write-Host "NextGenChat is installed as a Windows Scheduled Task." -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000"
Write-Host "Backend:  http://localhost:3001"
Write-Host "Task:     $env:WINDIR\System32\schtasks.exe /Query /TN NextGenChat"
