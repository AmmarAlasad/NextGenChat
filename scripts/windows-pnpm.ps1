$PnpmVersion = if ($script:PnpmVersion) { $script:PnpmVersion } else { "10.33.0" }

function Get-NpmCommand {
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }

    $command = Get-Command npm -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }

    return $null
}

function Invoke-NativeOutput {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $FilePath @Arguments 2>$null
        $exitCode = $LASTEXITCODE
    }
    catch {
        return @{
            ExitCode = 1
            Output = @()
        }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    return @{
        ExitCode = $exitCode
        Output = @($output)
    }
}

function Test-NativeCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @("--version")
    )

    if (-not $FilePath) { return $false }
    if (-not (Test-Path -LiteralPath $FilePath)) { return $false }

    $result = Invoke-NativeOutput -FilePath $FilePath -Arguments $Arguments
    return ($result.ExitCode -eq 0)
}

function Get-NpmGlobalPrefix {
    $npmCommand = Get-NpmCommand
    if (-not $npmCommand) { return $null }

    $result = Invoke-NativeOutput -FilePath $npmCommand -Arguments @("prefix", "-g")
    $prefix = ($result.Output | Where-Object { $_ } | Select-Object -First 1)
    if ($prefix) {
        return ($prefix -as [string]).Trim()
    }

    return $null
}

function Add-ToProcessPath {
    param([string]$Directory)

    if (-not $Directory) { return }
    if (-not (Test-Path -LiteralPath $Directory)) { return }

    $pathParts = @($env:PATH -split [System.IO.Path]::PathSeparator | Where-Object { $_ })
    $alreadyPresent = $pathParts | Where-Object { $_.TrimEnd("\") -ieq $Directory.TrimEnd("\") } | Select-Object -First 1
    if (-not $alreadyPresent) {
        $env:PATH = "$Directory$([System.IO.Path]::PathSeparator)$env:PATH"
    }
}

function Get-PnpmCandidatePaths {
    $paths = New-Object System.Collections.Generic.List[string]

    foreach ($name in @("pnpm.cmd", "pnpm")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and $command.Source) {
            $paths.Add($command.Source)
        }
    }

    $npmPrefix = Get-NpmGlobalPrefix
    if ($npmPrefix) {
        Add-ToProcessPath -Directory $npmPrefix
        $paths.Add((Join-Path $npmPrefix "pnpm.cmd"))
    }

    if ($env:APPDATA) {
        $paths.Add((Join-Path $env:APPDATA "npm\pnpm.cmd"))
    }

    if ($env:ProgramFiles) {
        $paths.Add((Join-Path $env:ProgramFiles "nodejs\pnpm.cmd"))
    }

    if (${env:ProgramFiles(x86)}) {
        $paths.Add((Join-Path ${env:ProgramFiles(x86)} "nodejs\pnpm.cmd"))
    }

    return $paths | Where-Object { $_ } | Select-Object -Unique
}

function Get-PnpmPath {
    foreach ($candidate in Get-PnpmCandidatePaths) {
        if (Test-NativeCommand -FilePath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

function Ensure-PnpmCommand {
    param([string]$Version = $PnpmVersion)

    $pnpmPath = Get-PnpmPath
    if ($pnpmPath) { return $pnpmPath }

    $npmCommand = Get-NpmCommand
    if (-not $npmCommand) {
        throw "npm is required to install pnpm on Windows. Install Node.js 20+ and run the installer again."
    }

    Write-Host "  [WARN] No working pnpm command found. Installing pnpm@$Version with npm..." -ForegroundColor Yellow
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $npmCommand install -g "pnpm@$Version"
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -ne 0) {
        throw "Failed to install pnpm@$Version with npm."
    }

    $npmPrefix = Get-NpmGlobalPrefix
    if ($npmPrefix) {
        Add-ToProcessPath -Directory $npmPrefix
    }

    $pnpmPath = Get-PnpmPath
    if (-not $pnpmPath) {
        throw "pnpm was installed, but no runnable pnpm.cmd shim was found. Try opening a new PowerShell window and run the installer again."
    }

    return $pnpmPath
}
