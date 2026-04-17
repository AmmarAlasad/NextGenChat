$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path (Join-Path $rootDir "..")).Path
$logsDir = Join-Path $env:LOCALAPPDATA "NextGenChat\logs"

Set-Location $repoDir

function Get-NpmCommand {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { return "npm.cmd" }
    if (Get-Command npm -ErrorAction SilentlyContinue) { return "npm" }
    return $null
}

function Test-NativeCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @("--version")
    )

    if (-not $FilePath) { return $false }
    if (-not (Test-Path $FilePath)) { return $false }

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $FilePath @Arguments 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Get-PnpmPath {
    $npmCommand = Get-NpmCommand
    if (-not $npmCommand) {
        throw "npm is required to locate pnpm on Windows."
    }

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $npmPrefix = (& $npmCommand prefix -g 2>$null | Select-Object -First 1)
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($LASTEXITCODE -ne 0 -or -not $npmPrefix) {
        throw "Could not determine npm global prefix."
    }

    $pnpmPath = Join-Path ($npmPrefix.Trim()) "pnpm.cmd"
    if (-not (Test-NativeCommand -FilePath $pnpmPath)) {
        throw "Standalone pnpm.cmd not found. Re-run the installer."
    }

    return $pnpmPath
}

function Invoke-NativeLogged {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$LogPath,
        [string]$WorkingDirectory = $repoDir
    )

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        Push-Location $WorkingDirectory
        & $FilePath @Arguments 2>&1 | Tee-Object -FilePath $LogPath
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
        $ErrorActionPreference = $previousPreference
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

Invoke-NativeLogged -FilePath $pnpmPath -Arguments @("--filter", "@nextgenchat/backend", "prisma:generate") -LogPath (Join-Path $logsDir "service-prisma-generate.log")
Invoke-NativeLogged -FilePath $pnpmPath -Arguments @("--filter", "@nextgenchat/backend", "prisma:push") -LogPath (Join-Path $logsDir "service-prisma-push.log")

$backend = $null
$web = $null

try {
    $backendCommand = "$env:PORT='3001'; & '$pnpmPath' --filter '@nextgenchat/backend' start"
    $webCommand = "$env:PORT='3000'; & '$pnpmPath' --filter '@nextgenchat/web' start"

    $backend = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $backendCommand) -WorkingDirectory $repoDir -PassThru -RedirectStandardOutput (Join-Path $logsDir "backend.log") -RedirectStandardError (Join-Path $logsDir "backend.error.log")
    $web = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $webCommand) -WorkingDirectory $repoDir -PassThru -RedirectStandardOutput (Join-Path $logsDir "web.log") -RedirectStandardError (Join-Path $logsDir "web.error.log")

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
    if ($backend -and -not $backend.HasExited) {
        Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
    }

    if ($web -and -not $web.HasExited) {
        Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
    }
}
