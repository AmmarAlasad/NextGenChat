$ErrorActionPreference = "Stop"

$pnpmVersion = "10.33.0"
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path (Join-Path $rootDir "..")).Path
$logsDir = Join-Path $env:LOCALAPPDATA "NextGenChat\logs"

Set-Location $repoDir

function Write-Step {
    param([string]$Text)
    Write-Host "`n[STEP] $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  [WARN] $Text" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Text)
    Write-Error $Text
    exit 1
}

function Get-CommandVersion {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @("--version")
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        return ((& $FilePath @Arguments 2>$null | Select-Object -First 1) -as [string]).Trim()
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Invoke-GenerateSecret {
    return (node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
}

function Get-NpmCommand {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { return "npm.cmd" }
    if (Get-Command npm -ErrorAction SilentlyContinue) { return "npm" }
    return $null
}

function Get-PnpmShimCommand {
    $command = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }

    $command = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }

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

function Get-StandalonePnpmPath {
    $npmCommand = Get-NpmCommand
    if (-not $npmCommand) { return $null }

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $npmPrefix = (& $npmCommand prefix -g 2>$null | Select-Object -First 1)
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($LASTEXITCODE -ne 0 -or -not $npmPrefix) { return $null }

    $pnpmPath = Join-Path ($npmPrefix.Trim()) "pnpm.cmd"
    if (Test-NativeCommand -FilePath $pnpmPath) {
        return $pnpmPath
    }

    return $null
}

function Ensure-PnpmCommand {
    $standalonePnpm = Get-StandalonePnpmPath
    if ($standalonePnpm) {
        return $standalonePnpm
    }

    $npmCommand = Get-NpmCommand
    if (-not $npmCommand) {
        Write-Fail "npm is required to install pnpm on Windows."
    }

    Write-Warn "No working standalone pnpm installation found. Installing pnpm@$pnpmVersion with npm..."
    & $npmCommand install -g "pnpm@$pnpmVersion"
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Failed to install pnpm@$pnpmVersion with npm."
    }

    $standalonePnpm = Get-StandalonePnpmPath
    if (-not $standalonePnpm) {
        Write-Fail "pnpm is still unavailable after npm installation."
    }

    return $standalonePnpm
}

function Invoke-NativeLogged {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$LogPath,
        [string]$WorkingDirectory = $repoDir,
        [hashtable]$Environment = $null
    )

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

    $previousPreference = $ErrorActionPreference
    $previousDebug = $env:DEBUG
    $previousBacktrace = $env:RUST_BACKTRACE

    $ErrorActionPreference = "Continue"
    try {
        if ($Environment) {
            foreach ($entry in $Environment.GetEnumerator()) {
                [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value)
            }
        }

        Push-Location $WorkingDirectory
        & $FilePath @Arguments 2>&1 | Tee-Object -FilePath $LogPath
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
        if ($Environment) {
            foreach ($entry in $Environment.GetEnumerator()) {
                [Environment]::SetEnvironmentVariable($entry.Key, $null)
            }
        }
        $env:DEBUG = $previousDebug
        $env:RUST_BACKTRACE = $previousBacktrace
        $ErrorActionPreference = $previousPreference
    }

    return $exitCode
}

function Set-EnvValue {
    param([string]$Key, [string]$Value)

    if (-not (Test-Path ".env")) { return }
    $content = Get-Content ".env" -Raw
    if ($content -match "(?m)^$Key=.*`r?`n?") {
        $content = $content -replace "(?m)^$Key=.*", "$Key=$Value"
    } else {
        $content += "`n$Key=$Value"
    }
    Set-Content ".env" $content -NoNewline
}

function Get-EnvValue {
    param([string]$Key)

    if (-not (Test-Path ".env")) { return $null }
    $line = Get-Content ".env" | Where-Object { $_ -match "^$Key=" } | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line -replace "^$Key=", "").Trim('"')
}

function Ensure-SqliteTargets {
    $databaseUrl = Get-EnvValue "DATABASE_URL"
    if (-not $databaseUrl -or -not $databaseUrl.StartsWith("file:")) { return }

    $sqlitePath = $databaseUrl.Substring(5)
    if (-not [System.IO.Path]::IsPathRooted($sqlitePath)) {
        $sqlitePath = Join-Path $repoDir $sqlitePath
    }

    $parentDir = Split-Path -Parent $sqlitePath
    if ($parentDir) {
        New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
    }

    if (-not (Test-Path $sqlitePath)) {
        New-Item -ItemType File -Force -Path $sqlitePath | Out-Null
    }
}

function Invoke-PrismaBootstrap {
    param([string]$PnpmPath)

    Write-Step "Syncing Prisma client and local database"

    $backendDir = Join-Path $repoDir "apps/backend"
    Copy-Item ".env" "apps/backend/.env" -Force
    Ensure-SqliteTargets

    $generateExit = Invoke-NativeLogged -FilePath $PnpmPath -Arguments @("exec", "prisma", "generate") -WorkingDirectory $backendDir -LogPath (Join-Path $logsDir "prisma-generate.log")
    if ($generateExit -ne 0) {
        Write-Fail "Prisma generate failed. Check $logsDir\prisma-generate.log"
    }

    $pushExit = Invoke-NativeLogged -FilePath $PnpmPath -Arguments @("exec", "prisma", "db", "push", "--skip-generate") -WorkingDirectory $backendDir -LogPath (Join-Path $logsDir "prisma-push.log")
    if ($pushExit -ne 0) {
        Write-Warn "Prisma db push failed. Retrying once with debug logging..."
        $env:DEBUG = "prisma:*"
        $env:RUST_BACKTRACE = "1"
        Copy-Item ".env" "apps/backend/.env" -Force
        Ensure-SqliteTargets
        $pushRetryExit = Invoke-NativeLogged -FilePath $PnpmPath -Arguments @("exec", "prisma", "db", "push", "--skip-generate") -WorkingDirectory $backendDir -LogPath (Join-Path $logsDir "prisma-push-retry.log")
        if ($pushRetryExit -ne 0) {
            $databaseUrl = Get-EnvValue "DATABASE_URL"
            Write-Fail "Prisma db push failed after retry. DATABASE_URL=$databaseUrl. Check $logsDir\prisma-push.log and $logsDir\prisma-push-retry.log"
        }
    }

    Write-Ok "SQLite schema is ready"
}

Write-Host "`nNextGenChat - Local setup (Windows Native)" -ForegroundColor Cyan
Write-Host ""

Write-Step "Checking prerequisites"
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCommand) { Write-Fail "Git is required. Install Git for Windows, then run the command again." }
Write-Ok "git $((Get-CommandVersion -FilePath $gitCommand.Source))"

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { Write-Fail "Node.js 20+ is required. Install Node.js LTS, then run the command again." }
$nodeVersion = Get-CommandVersion -FilePath $nodeCommand.Source
Write-Ok "Node.js $nodeVersion"

$npmCommand = Get-NpmCommand
if (-not $npmCommand) { Write-Fail "npm is required. Install Node.js LTS, then run the command again." }
Write-Ok "npm $((Get-CommandVersion -FilePath $npmCommand))"

$pnpmPath = Ensure-PnpmCommand
Write-Ok "pnpm $((Get-CommandVersion -FilePath $pnpmPath))"

Write-Step "Creating local environment"

$winDir = Join-Path $env:LOCALAPPDATA "NextGenChat"
$winDirPosix = $winDir -replace "\\", "/"
$dbPath = "$winDirPosix/dev.db"
$workspacesPath = "$winDirPosix/agent-workspaces"

New-Item -ItemType Directory -Force -Path $winDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $winDir "agent-workspaces") | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $winDir "dev.db") | Out-Null

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Set-EnvValue "JWT_SECRET" (Invoke-GenerateSecret)
    Set-EnvValue "JWT_REFRESH_SECRET" (Invoke-GenerateSecret)
    Set-EnvValue "ENCRYPTION_KEY" (Invoke-GenerateSecret)
    Write-Ok "Created .env for local SQLite mode"
} else {
    Write-Warn "Using existing .env"
}

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
$installExit = Invoke-NativeLogged -FilePath $pnpmPath -Arguments @("install") -WorkingDirectory $repoDir -LogPath (Join-Path $logsDir "pnpm-install.log")
if ($installExit -ne 0) {
    Write-Fail "Dependency installation failed. Check $logsDir\pnpm-install.log"
}
Write-Ok "Dependencies installed"

Invoke-PrismaBootstrap -PnpmPath $pnpmPath

Write-Host "`n[OK] Local setup complete" -ForegroundColor Green
Write-Host "`n  pnpm dev:local:win   - start the app"
Write-Host "  Press Ctrl+C         - stop dev servers"
Write-Host ""
Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:3001" -ForegroundColor Cyan
Write-Host "  Logs:     $logsDir" -ForegroundColor Cyan
Write-Host ""
