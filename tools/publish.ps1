# Publish: one double-click to send your changes to GitHub and wait until Render has them live.
# Run it with publish.bat (Windows). Safe to run again at any time.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Repo    = 'https://github.com/magedazony/exam-simulator.git'
$Site    = 'https://exam-simulator-k925.onrender.com'
$Branch  = 'main'
$Wait    = 15     # seconds between checks
$MaxWait = 900    # give up after 15 minutes

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Stop-With($text) { Say ""; Say $text Red; Read-Host "Press Enter to close"; exit 1 }

# 1. Git must be installed.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Say "Git is not installed." Yellow
  if ((Read-Host "Install it now with winget? (y/n)") -eq 'y') {
    winget install --id Git.Git -e --source winget
    Stop-With "Git installed. Close this window and double-click publish.bat again."
  }
  Stop-With "Install Git from https://git-scm.com/download/win and run this again."
}

# 2. Find the project folder (the folder above this script), or download it the first time.
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root '.git'))) {
  $Root = Join-Path $env:USERPROFILE 'exam-simulator'
  if (-not (Test-Path (Join-Path $Root '.git'))) {
    Say "Downloading the project to $Root ..." Cyan
    git clone $Repo $Root
    if ($LASTEXITCODE) { Stop-With "Could not download the project." }
    Say "Done. Put your changes in this folder, then double-click tools\publish.bat inside it." Green
    Start-Process explorer.exe $Root
    Read-Host "Press Enter to close"; exit 0
  }
}
Set-Location $Root
Say "Project folder: $Root" Cyan

# 3. Bring in the latest version first, keeping your changes.
git checkout $Branch 2>$null | Out-Null
git pull --rebase --autostash origin $Branch
if ($LASTEXITCODE) { Stop-With "Could not merge the latest version from GitHub with your changes. Check your internet, or fix the files marked as conflicted and run this again." }

# Git needs a name and email for the history, once per computer.
if (-not (git config user.email)) {
  git config --global user.name  (Read-Host "Your name (for the change history)")
  git config --global user.email (Read-Host "Your GitHub email")
}

# 4. Show what will be sent.
$changes = git status --porcelain
if (-not $changes) {
  Say "No changes to send." Yellow
  $hookFile = Join-Path $PSScriptRoot 'deploy-hook.txt'
  if ((Test-Path $hookFile) -and ((Read-Host "Redeploy the site anyway? (y/n)") -eq 'y')) {
    Invoke-RestMethod -Method Post -Uri (Get-Content $hookFile -Raw).Trim() | Out-Null
    Say "Redeploy started. It takes 3-5 minutes." Green
  }
  Read-Host "Press Enter to close"; exit 0
}
Say ""; Say "Files that will be sent:" Cyan
git status --short
Say ""
$msg = Read-Host "Describe the change in a few words (or press Enter)"
if (-not $msg) { $msg = "Update " + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
if ((Read-Host "Send these changes and publish? (y/n)") -ne 'y') { Stop-With "Nothing was sent." }

# 5. Save and send.
git add -A
git commit -m $msg | Out-Null
if ($LASTEXITCODE) { Stop-With "Could not save the changes." }
git push origin $Branch
if ($LASTEXITCODE) { Stop-With "Could not send to GitHub. If a sign-in window opened, finish it and run this again." }
$sha = (git rev-parse --short=7 HEAD).Trim()
Say "Sent to GitHub ($sha). Render is now building it..." Green

# 6. Wait until the site runs the new version.
$start = Get-Date
while (((Get-Date) - $start).TotalSeconds -lt $MaxWait) {
  Start-Sleep -Seconds $Wait
  try {
    $h = Invoke-RestMethod -Uri "$Site/api/v1/health" -TimeoutSec 20
    $mins = [int]((Get-Date) - $start).TotalMinutes
    if ($h.version -eq $sha) {
      Say ""; Say "LIVE: the site is running your change ($sha)." Green
      Start-Process "$Site/app"
      Read-Host "Press Enter to close"; exit 0
    }
    Say "  still building... ($mins min, site is on $($h.version))"
  } catch { Say "  site is restarting..." }
}
Stop-With "The site did not switch to $sha within 15 minutes. Open https://dashboard.render.com > exam-simulator > Events / Logs to see why."
