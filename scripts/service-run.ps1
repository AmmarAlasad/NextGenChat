$ErrorActionPreference = "Stop"

$pnpmVersion = "10.33.0"

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
    $command = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($command -and $command.Source -and ($command.Source -notmatch "corepack")) {
        if (Test-StandalonePnpmPath -FilePath $command.Source) {
            return @{ FilePath = $command.Source; PrefixArgs = @() }
        }
    }

    $npmCommand = Get-NpmLaunchCommand
    if ($npmCommand) {
        $npmPrefix = (& $npmCommand prefix -g).Trim()
        if ($LASTEXITCODE -eq 0 -and $npmPrefix) {
            $pnpmPath = Join-Path $npmPrefix "pnpm.cmd"
            if (Test-StandalonePnpmPath -FilePath $pnpmPath) {
                return @{ FilePath = $pnpmPath; PrefixArgs = @() }
            }
        }
    }

    throw "pnpm is required to run NextGenChat on Windows."
}

if (-not (Test-Path ".env")) {
    Write-Error ".env file not found. Run scripts/setup.ps1 first."
    exit 1
}

Copy-Item ".env" "apps/backend/.env" -Force

$pnpmCommand = Get-PnpmLaunchCommand

& $pnpmCommand.FilePath @($pnpmCommand.PrefixArgs + @("--filter", "@nextgenchat/backend", "prisma:generate"))
& $pnpmCommand.FilePath @($pnpmCommand.PrefixArgs + @("--filter", "@nextgenchat/backend", "prisma:push"))
& $pnpmCommand.FilePath @($pnpmCommand.PrefixArgs + @("build"))

$backend = $null
$web = $null

try {
    $backend = Start-Process -FilePath $pnpmCommand.FilePath -ArgumentList @($pnpmCommand.PrefixArgs + @("--filter", "@nextgenchat/backend", "start")) -WorkingDirectory (Get-Location).Path -PassThru -Environment @{ PORT = "3001" }
    $web = Start-Process -FilePath $pnpmCommand.FilePath -ArgumentList @($pnpmCommand.PrefixArgs + @("--filter", "@nextgenchat/web", "start")) -WorkingDirectory (Get-Location).Path -PassThru -Environment @{ PORT = "3000" }

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
