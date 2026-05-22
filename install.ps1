#Requires -Version 5.1
<#
.SYNOPSIS
    Ghost Installer for Windows.
.DESCRIPTION
    Installs @hyperflow.fun/ghost globally via bun from the public
    npm registry. Bootstraps Bun if missing.
.PARAMETER Channel
    Release channel to install from — latest (default) or rc.
.PARAMETER Help
    Show help message.
.EXAMPLE
    .\install.ps1
    # Interactive install + onboard
.EXAMPLE
    powershell -c "irm https://<URL>/install.ps1 | iex"
    # One-liner: install + onboard from web
#>
param(
    [ValidateSet("latest","rc")]
    [string]$Channel = "latest",
    [switch]$Help
)

$Script:PackageName = "@hyperflow.fun/ghost"

# Detect "Run with PowerShell" double-click so we can pause at the end.
$IsDoubleClicked = $false
try {
    $parentProcess = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).ParentProcessId
    if ($parentProcess) {
        $parentName = (Get-Process -Id $parentProcess -ErrorAction SilentlyContinue).ProcessName
        if ($parentName -eq "explorer") { $IsDoubleClicked = $true }
    }
} catch { }

$HomeDir = [Environment]::GetFolderPath("UserProfile")
if ([string]::IsNullOrEmpty($HomeDir)) { $HomeDir = $env:HOME }
$GhostConfig = Join-Path (Join-Path $HomeDir ".ghost") "config.json"
$TotalStages = 3
$CurrentStage = 0

# ------------------------------------------------------------------
# UI
# ------------------------------------------------------------------

function Write-Banner {
    Write-Host ""
    Write-Host "   GHOST" -ForegroundColor Magenta
    Write-Host "   AI Trading Companion for Hyperliquid" -ForegroundColor Magenta
    Write-Host ""
}

function Write-Stage {
    param([string]$Message)
    $script:CurrentStage++
    Write-Host ""
    Write-Host "[$script:CurrentStage/$TotalStages] $Message" -ForegroundColor Magenta
}

function Write-Info { param([string]$Message) Write-Host "  $Message" -ForegroundColor Gray }
function Write-OK { param([string]$Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Err { param([string]$Message) Write-Host "[X] $Message" -ForegroundColor Red }
function Write-Warn2 { param([string]$Message) Write-Host "[!] $Message" -ForegroundColor Yellow }

function Show-Usage {
    Write-Host "Ghost Installer"
    Write-Host ""
    Write-Host "Usage: .\install.ps1 [OPTIONS]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Channel <v>     Release channel: latest (default) or rc"
    Write-Host "  -Help            Show this help message"
}

if ($Help) {
    Show-Usage
    exit 0
}

# ------------------------------------------------------------------
# Phase: Bun bootstrap
# ------------------------------------------------------------------

function Install-Bun {
    Write-Stage "Checking Bun runtime"

    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($bunCmd) {
        $bunVer = & bun --version 2>$null
        Write-OK "Bun v$bunVer already installed"
        return
    }

    Write-Info "Bun not found -- installing..."

    try {
        $installScript = Invoke-RestMethod https://bun.sh/install.ps1 -ErrorAction Stop
        Invoke-Expression $installScript
    } catch {
        Write-Err "Failed to download/run Bun installer: $_"
        Write-Info "Manual install: https://bun.sh/docs/installation"
        exit 1
    }

    # Refresh PATH for current session — guard against duplicate entries.
    $bunPath = Join-Path (Join-Path $HomeDir ".bun") "bin"
    if (Test-Path $bunPath) {
        if ($env:PATH -notlike "*$bunPath*") {
            $env:PATH = "$bunPath;$env:PATH"
        }
    }

    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($bunCmd) {
        $bunVer = & bun --version 2>$null
        Write-OK "Bun v$bunVer installed"
    } else {
        Write-Err "Bun installation completed but 'bun' command not found."
        Write-Info "Try restarting PowerShell, then run this script again."
        exit 1
    }
}

# ------------------------------------------------------------------
# Phase: Install Ghost from npm registry
# ------------------------------------------------------------------

function Install-GhostFromRegistry {
    Write-Stage "Installing Ghost"
    Write-Info "Package: $($Script:PackageName)"
    Write-Info "Channel: $Channel"

    # `@<channel>` resolves the npm dist-tag; `--no-cache` ignores bun's
    # manifest cache so a freshly-published release is picked up.
    & bun install -g "$($Script:PackageName)@$Channel" --no-cache

    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to install $($Script:PackageName)."
        exit 1
    }

    # Ensure ~/.bun/bin is on PATH — session + persistent user PATH.
    $bunBin = Join-Path (Join-Path $HomeDir ".bun") "bin"
    if (Test-Path $bunBin) {
        if ($env:PATH -notlike "*$bunBin*") {
            $env:PATH = "$bunBin;$env:PATH"
        }
        $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
        if ([string]::IsNullOrEmpty($userPath)) {
            [Environment]::SetEnvironmentVariable("PATH", $bunBin, "User")
            Write-Info "Added $bunBin to user PATH"
            Write-Warn2 "Restart your terminal for PATH changes to take effect"
        } elseif ($userPath -notlike "*$bunBin*") {
            [Environment]::SetEnvironmentVariable("PATH", "$bunBin;$userPath", "User")
            Write-Info "Added $bunBin to user PATH"
            Write-Warn2 "Restart your terminal for PATH changes to take effect"
        }
    }

    $ghostCmd = Get-Command ghost -ErrorAction SilentlyContinue
    if ($ghostCmd) {
        Write-OK "Ghost installed -- 'ghost' is on your PATH"
    } else {
        Write-Warn2 "Installed, but 'ghost' not yet on PATH for this session."
        Write-Info "Open a new terminal or re-run your profile."
    }
}

# ------------------------------------------------------------------
# Phase: Post-install
# ------------------------------------------------------------------

function Invoke-PostInstall {
    Write-Stage "Finalizing"

    Write-Host ""
    Write-OK "Ghost installed successfully!"
    Write-Host ""

    if (Test-Path $GhostConfig) {
        Write-Info "Existing config found at $GhostConfig"
        Write-Info "Run 'ghost daemon' to start Ghost."
        return
    }

    if ([Environment]::UserInteractive) {
        Write-Info "Starting onboard wizard..."
        Write-Host ""
        $ghostCmd = Get-Command ghost -ErrorAction SilentlyContinue
        if ($ghostCmd) {
            & ghost onboard
        } else {
            $bunBin = Join-Path (Join-Path $HomeDir ".bun") "bin"
            $ghostPath = Join-Path $bunBin "ghost"
            if (Test-Path $ghostPath) {
                & $ghostPath onboard
            } else {
                Write-Warn2 "Could not find 'ghost' binary. Run manually: ghost onboard"
            }
        }
    } else {
        Write-Warn2 "Non-interactive shell — run 'ghost onboard' when ready."
    }
}

# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------

try {
    Write-Banner
    Install-Bun
    Install-GhostFromRegistry
    Invoke-PostInstall
} catch {
    Write-Host ""
    Write-Err "Installation failed: $_"
    Write-Err "Stack trace: $($_.ScriptStackTrace)"
    if ($IsDoubleClicked) { Read-Host "`nPress Enter to exit" }
    exit 1
}

if ($IsDoubleClicked) { Read-Host "`nPress Enter to exit" }
