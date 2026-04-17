$ErrorActionPreference = "Stop"

$pnpmVersion = "10.33.0"

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

function Test-PnpmCommand {
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

function Get-PnpmCommand {
    $candidates = @(
        @{ FilePath = "pnpm.cmd"; PrefixArgs = @() },
        @{ FilePath = "pnpm"; PrefixArgs = @() },
        @{ FilePath = "corepack.cmd"; PrefixArgs = @("pnpm@$pnpmVersion") },
        @{ FilePath = "corepack"; PrefixArgs = @("pnpm@$pnpmVersion") }
    )

    foreach ($candidate in $candidates) {
        if (Get-Command $candidate.FilePath -ErrorAction SilentlyContinue) {
            if (Test-PnpmCommand -FilePath $candidate.FilePath -PrefixArgs $candidate.PrefixArgs) {
                return $candidate
            }
        }
    }

    return $null
}

function Ensure-PnpmCommand {
    $pnpmCommand = Get-PnpmCommand
    if ($pnpmCommand) {
        return $pnpmCommand
    }

    Write-Warn "No working pnpm command found. Attempting to install pnpm@$pnpmVersion with npm..."

    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue) -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Error "npm is required to install pnpm on Windows."
        exit 1
    }

    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        & npm.cmd install -g "pnpm@$pnpmVersion"
    }
    else {
        & npm install -g "pnpm@$pnpmVersion"
    }

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

Write-Host "`nNextGenChat - Local setup (Windows Native)" -ForegroundColor Cyan
Write-Host ""

Write-Step "Checking prerequisites"
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Ok "git is available" } else { Write-Error "git is required"; exit 1 }
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Ok "Node.js is available" } else { Write-Error "Node.js 20+ is required"; exit 1 }

if (Get-Command corepack -ErrorAction SilentlyContinue) {
    corepack enable | Out-Null
    corepack prepare pnpm@$pnpmVersion --activate | Out-Null
}

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

Write-Step "Syncing Prisma client and local database"
Invoke-Pnpm --filter @nextgenchat/backend prisma:generate
Invoke-Pnpm --filter @nextgenchat/backend prisma:push
Write-Ok "SQLite schema is ready"

Write-Host "`n[OK] Local setup complete" -ForegroundColor Green
Write-Host "`n  pnpm dev:local:win   - start the app"
Write-Host "  Press Ctrl+C         - stop dev servers"
Write-Host ""
Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:3001" -ForegroundColor Cyan
Write-Host ""
