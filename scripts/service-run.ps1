$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path (Join-Path $rootDir "..")).Path
$logsDir = Join-Path $env:LOCALAPPDATA "NextGenChat\logs"
$pidFile = Join-Path $env:LOCALAPPDATA "NextGenChat\service-pids.json"

Set-Location $repoDir
. (Join-Path $rootDir "windows-pnpm.ps1")

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

if (-not (Test-Path ".env")) {
    throw ".env file not found. Run scripts/setup.ps1 first."
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Copy-Item ".env" "apps/backend/.env" -Force

$pnpmPath = Get-PnpmPath
if (-not $pnpmPath) {
    throw "pnpm is unavailable. Re-run the installer."
}

Invoke-NativeLogged -FilePath $pnpmPath -Arguments @("--filter", "@nextgenchat/backend", "prisma:generate") -LogPath (Join-Path $logsDir "service-prisma-generate.log")
Invoke-NativeLogged -FilePath $pnpmPath -Arguments @("--filter", "@nextgenchat/backend", "prisma:push") -LogPath (Join-Path $logsDir "service-prisma-push.log")

$backend = $null
$web = $null

try {
    $backendCommand = "$env:PORT='3001'; & '$pnpmPath' --filter '@nextgenchat/backend' start"
    $webCommand = "$env:PORT='3000'; & '$pnpmPath' --filter '@nextgenchat/web' start"

    $backend = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", $backendCommand) -WindowStyle Hidden -WorkingDirectory $repoDir -PassThru -RedirectStandardOutput (Join-Path $logsDir "backend.log") -RedirectStandardError (Join-Path $logsDir "backend.error.log")
    $web = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", $webCommand) -WindowStyle Hidden -WorkingDirectory $repoDir -PassThru -RedirectStandardOutput (Join-Path $logsDir "web.log") -RedirectStandardError (Join-Path $logsDir "web.error.log")

    @{
        runner = $PID
        backend = $backend.Id
        web = $web.Id
        startedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content -Path $pidFile -Encoding UTF8

    while ($true) {
        Start-Sleep -Seconds 2

        if ($backend.HasExited -or $web.HasExited) {
            $backendCode = if ($backend.HasExited) { $backend.ExitCode } else { 0 }
            $webCode = if ($web.HasExited) { $web.ExitCode } else { 0 }
            if ($backendCode -ne 0) { exit $backendCode }
            if ($webCode -ne 0) { exit $webCode }
            exit 0
        }
    }
}
finally {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

    if ($backend -and -not $backend.HasExited) {
        Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
    }

    if ($web -and -not $web.HasExited) {
        Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
    }
}
