$ErrorActionPreference = "Stop"

$pnpmVersion = "10.33.0"
$logsDir = Join-Path $env:LOCALAPPDATA "NextGenChat\logs"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $rootDir "..")

function Write-Step {
    param([string]$text)
    Write-Host "`n[STEP] $text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$text)
    Write-Host "  [OK] $text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$text)
    Write-Host "  [WARN] $text" -ForegroundColor Yellow
}

function Invoke-GenerateSecret {
    return (node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
}

function Get-NpmCommand {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        return "npm.cmd"
    }

    if (Get-Command npm -ErrorAction SilentlyContinue) {
        return "npm"
    }

    return $null
}

function Get-StandalonePnpmPath {
    $npmCommand = Get-NpmCommand
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

function Get-PnpmCommand {
    $pnpmPath = Get-StandalonePnpmPath
    if ($pnpmPath -and (Test-StandalonePnpmPath -FilePath $pnpmPath)) {
        return @{ FilePath = $pnpmPath }
    }

    return $null
}

function Ensure-PnpmCommand {
    $pnpmCommand = Get-PnpmCommand
    if ($pnpmCommand) {
        return $pnpmCommand
    }

    $npmCommand = Get-NpmCommand
    if (-not $npmCommand) {
        Write-Error "npm is required to install pnpm on Windows."
        exit 1
    }

    Write-Warn "No working standalone pnpm installation found. Installing pnpm@$pnpmVersion with npm..."
    & $npmCommand install -g "pnpm@$pnpmVersion"

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to install pnpm@$pnpmVersion with npm."
        exit $LASTEXITCODE
    }

    $pnpmCommand = Get-PnpmCommand
    if (-not $pnpmCommand) {
        Write-Error "pnpm is still unavailable after npm installation."
        exit 1
    }

    return $pnpmCommand
}

function Invoke-Pnpm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    $pnpmCommand = Ensure-PnpmCommand

    & $pnpmCommand.FilePath @($pnpmCommand.PrefixArgs + $Arguments)
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

function Get-EnvValue {
    param([string]$key)

    if (-not (Test-Path ".env")) { return $null }

    $line = Get-Content ".env" | Where-Object { $_ -match "^$key=" } | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line -replace "^$key=", "").Trim('"')
}

function Set-EnvValue {
    param([string]$key, [string]$value)
    
    if (-not (Test-Path ".env")) { return }
    $content = Get-Content ".env" -Raw
    if ($content -match "(?m)^$key=.*`r?`n?") {
        $content = $content -replace "(?m)^$key=.*", "$key=$value"
    } else {
        $content += "`n$key=$value"
    }
    Set-Content ".env" $content -NoNewline
}

function Ensure-SqliteParentDirectory {
    $databaseUrl = Get-EnvValue "DATABASE_URL"
    if (-not $databaseUrl -or -not $databaseUrl.StartsWith("file:")) { return }

    $sqlitePath = $databaseUrl.Substring(5)
    if (-not [System.IO.Path]::IsPathRooted($sqlitePath)) {
        $sqlitePath = Join-Path (Get-Location).Path $sqlitePath
    }

    $parentDir = Split-Path -Parent $sqlitePath
    if ($parentDir) {
        New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
    }
}

function Invoke-PrismaCommand {
    param(
        [string[]]$Arguments,
        [string]$LogFile,
        [switch]$EnableDebug
    )

    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
    Copy-Item ".env" "apps/backend/.env" -Force
    Ensure-SqliteParentDirectory

    $backendDir = Join-Path (Get-Location).Path "apps/backend"
    $logPath = Join-Path $logsDir $LogFile
    $pnpmCommand = Ensure-PnpmCommand
    $originalDebug = $env:DEBUG
    $originalBacktrace = $env:RUST_BACKTRACE

    if ($EnableDebug) {
        $env:DEBUG = "prisma:*"
        $env:RUST_BACKTRACE = "1"
    }

    try {
        Push-Location $backendDir
        & $pnpmCommand.FilePath @Arguments *>&1 | Tee-Object -FilePath $logPath
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        Pop-Location
        $env:DEBUG = $originalDebug
        $env:RUST_BACKTRACE = $originalBacktrace
    }
}

function Invoke-PrismaBootstrap {
    Write-Step "Syncing Prisma client and local database"

    $generateOk = Invoke-PrismaCommand -Arguments @("exec", "prisma", "generate") -LogFile "prisma-generate.log"
    if (-not $generateOk) {
        Write-Error "Prisma generate failed. Check $logsDir\prisma-generate.log"
        exit 1
    }

    $pushOk = Invoke-PrismaCommand -Arguments @("exec", "prisma", "db", "push", "--skip-generate") -LogFile "prisma-push.log"
    if (-not $pushOk) {
        Write-Warn "Prisma db push failed. Retrying once with detailed debug logs..."
        Copy-Item ".env" "apps/backend/.env" -Force
        Ensure-SqliteParentDirectory
        $pushOk = Invoke-PrismaCommand -Arguments @("exec", "prisma", "db", "push", "--skip-generate") -LogFile "prisma-push-retry.log" -EnableDebug
        if (-not $pushOk) {
            $databaseUrl = Get-EnvValue "DATABASE_URL"
            Write-Error "Prisma db push failed after retry. DATABASE_URL=$databaseUrl"
            Write-Error "Check logs: $logsDir\prisma-push.log and $logsDir\prisma-push-retry.log"
            exit 1
        }
    }

    Write-Ok "SQLite schema is ready"
}

Write-Host "`nNextGenChat - Local setup (Windows Native)" -ForegroundColor Cyan
Write-Host ""

Write-Step "Checking prerequisites"
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Ok "git is available" } else { Write-Error "git is required"; exit 1 }
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Ok "Node.js is available" } else { Write-Error "Node.js 20+ is required"; exit 1 }

$resolvedPnpm = Ensure-PnpmCommand
Write-Ok "pnpm is available via $($resolvedPnpm.FilePath)"

Write-Step "Creating local environment"

$winDir = "$env:LOCALAPPDATA\NextGenChat"
$winDirPosix = $winDir -replace "\\", "/"
$nextgenchatHome = $winDirPosix
$dbPath = "$nextgenchatHome/dev.db"
$workspacesPath = "$nextgenchatHome/agent-workspaces"

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Set-EnvValue "JWT_SECRET" (Invoke-GenerateSecret)
    Set-EnvValue "JWT_REFRESH_SECRET" (Invoke-GenerateSecret)
    Set-EnvValue "ENCRYPTION_KEY" (Invoke-GenerateSecret)
    Write-Ok "Created .env for local SQLite mode"
} else {
    Write-Warn "Using existing .env"
}

New-Item -ItemType Directory -Force -Path $winDir | Out-Null
New-Item -ItemType Directory -Force -Path "$winDir\agent-workspaces" | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

Set-EnvValue "DEPLOYMENT_MODE" "local"
Set-EnvValue "DATABASE_URL" "file:$dbPath"
Set-EnvValue "REDIS_ENABLED" "false"
Set-EnvValue "REDIS_URL" ""
Set-EnvValue "AGENT_WORKSPACES_DIR" $workspacesPath

Write-Ok "Local installation data root: $winDir"
Write-Ok "SQLite database will be stored at $dbPath"
Write-Ok "Agent workspaces will be stored at $workspacesPath"

Copy-Item ".env" "apps/backend/.env" -Force
Write-Ok "Synced backend Prisma env"

Write-Step "Installing workspace dependencies"
Invoke-Pnpm install
Write-Ok "Dependencies installed"

Invoke-PrismaBootstrap

Write-Host "`n[OK] Local setup complete" -ForegroundColor Green
Write-Host "`n  pnpm dev:local:win   - start the app"
Write-Host "  Press Ctrl+C         - stop dev servers"
Write-Host ""
Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:3001" -ForegroundColor Cyan
Write-Host ""
