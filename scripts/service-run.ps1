$ErrorActionPreference = "Stop"

$pnpmVersion = "10.33.0"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $rootDir "..")

function Test-PnpmLaunchCommand {
    param(
        [string]$FilePath,
        [string[]]$PrefixArgs = @()
    )

    try {
        & $FilePath @($PrefixArgs + @("--version")) | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}

function Get-PnpmLaunchCommand {
    $candidates = @(
        @{ FilePath = "pnpm.cmd"; PrefixArgs = @() },
        @{ FilePath = "pnpm"; PrefixArgs = @() },
        @{ FilePath = "corepack.cmd"; PrefixArgs = @("pnpm@$pnpmVersion") },
        @{ FilePath = "corepack"; PrefixArgs = @("pnpm@$pnpmVersion") }
    )

    foreach ($candidate in $candidates) {
        if (Get-Command $candidate.FilePath -ErrorAction SilentlyContinue) {
            if (Test-PnpmLaunchCommand -FilePath $candidate.FilePath -PrefixArgs $candidate.PrefixArgs) {
                return $candidate
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
