$ErrorActionPreference = "Stop"

$repoUrl = if ($env:NEXTGENCHAT_REPO_URL) { $env:NEXTGENCHAT_REPO_URL } else { "https://github.com/AmmarAlasad/NextGenChat.git" }
$installDir = if ($env:NEXTGENCHAT_DIR) { $env:NEXTGENCHAT_DIR } else { Join-Path $env:USERPROFILE "NextGenChat" }

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

powershell -ExecutionPolicy Bypass -File "scripts/setup.ps1"
powershell -ExecutionPolicy Bypass -File "scripts/service-install.ps1"

Write-Host ""
Write-Host "NextGenChat is installed as a Windows Scheduled Task." -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000"
Write-Host "Backend:  http://localhost:3001"
Write-Host "Task:     $env:WINDIR\System32\schtasks.exe /Query /TN NextGenChat"
