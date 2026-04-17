$ErrorActionPreference = "Stop"

$pnpmVersion = "10.33.0"
$logsDir = Join-Path $env:LOCALAPPDATA "NextGenChat\logs"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $rootDir "..")

function Get-NpmLaunchCommand {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        return "npm.cmd"
    }

    if (Get-Command npm -ErrorAction SilentlyContinue) {
        return "npm"
    }

    return $null
}

function Get-StandalonePnpmPath {
    $npmCommand = Get-NpmLaunchCommand
    if (-not $npmCommand) { return $null }

    $npmPrefix = (& $npmCommand prefix -g).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $npmPrefix) { return $null }
    return (Join-Path $npmPrefix "pnpm.cmd")
}

function Test-StandalonePnpmPath {
    param([string]$FilePath)

    if (-not $FilePath) { return $false }
    if (-not (Test-Path $FilePath)) { return $false }

    try {
        & $FilePath --version | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}

function Get-PnpmLaunchCommand {
    $pnpmPath = Get-StandalonePnpmPath
    if ($pnpmPath -and (Test-StandalonePnpmPath -FilePath $pnpmPath)) {
        return @{ FilePath = $pnpmPath; PrefixArgs = @() }
    }

    throw "pnpm is required to run NextGenChat on Windows."
}

if (-not (Test-Path ".env")) {
    Write-Error ".env file not found. Run scripts/setup.ps1 first."
    exit 1
}

Copy-Item ".env" "apps/backend/.env" -Force
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$pnpmCommand = Get-PnpmLaunchCommand

& $pnpmCommand.FilePath @($pnpmCommand.PrefixArgs + @("--filter", "@nextgenchat/backend", "prisma:generate")) *>&1 | Tee-Object -FilePath (Join-Path $logsDir "service-prisma-generate.log")
& $pnpmCommand.FilePath @($pnpmCommand.PrefixArgs + @("--filter", "@nextgenchat/backend", "prisma:push")) *>&1 | Tee-Object -FilePath (Join-Path $logsDir "service-prisma-push.log")
& $pnpmCommand.FilePath @($pnpmCommand.PrefixArgs + @("build")) *>&1 | Tee-Object -FilePath (Join-Path $logsDir "service-build.log")

$backend = $null
$web = $null

try {
    $backendCommand = "$env:PORT='3001'; & '$($pnpmCommand.FilePath)' --filter '@nextgenchat/backend' start"
    $webCommand = "$env:PORT='3000'; & '$($pnpmCommand.FilePath)' --filter '@nextgenchat/web' start"

    $backend = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $backendCommand) -WorkingDirectory (Get-Location).Path -PassThru -RedirectStandardOutput (Join-Path $logsDir "backend.log") -RedirectStandardError (Join-Path $logsDir "backend.error.log")
    $web = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $webCommand) -WorkingDirectory (Get-Location).Path -PassThru -RedirectStandardOutput (Join-Path $logsDir "web.log") -RedirectStandardError (Join-Path $logsDir "web.error.log")

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
