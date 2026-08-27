<#
.SYNOPSIS
    Cut a FlairNode release: write VERSION, commit, tag. Does NOT push.

.DESCRIPTION
    A version is a git tag, and the tag string is the content of VERSION
    (see claude/flairnode-updater-v3-spec.md section 2). Devices install
    tags only, so every installable artifact has a unique version and the
    fleet census means something.

    Bumping a version is four acts that must not drift apart: write VERSION,
    commit, tag, push. This script does the first three as one operation so
    they cannot get half-done, and refuses loudly rather than producing a
    release whose VERSION and tag disagree.

    It deliberately does NOT push. Pushing flairnode main is the deploy
    action for this repo and stays a separate, deliberate human act. The
    script prints the exact commands to run.

.PARAMETER Version
    Semantic version without the leading v, e.g. 1.1.0. The tag becomes v1.1.0.

.PARAMETER AllowBranch
    Permit cutting a release from a branch other than main. Off by default.

.EXAMPLE
    .\tools\release.ps1 -Version 1.1.0
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Version,

    [switch] $AllowBranch
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host ""
    Write-Host "RELEASE ABORTED: $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}

function Step($msg) {
    Write-Host "  $msg" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "FlairNode release" -ForegroundColor Cyan
Write-Host ""

# --- 1. we are where we think we are ----------------------------------------
if (-not (Test-Path ".git"))          { Fail "no .git here - run this from the repository root" }
if (-not (Test-Path "FlairNode.js"))  { Fail "no FlairNode.js here - this does not look like the flairnode repo" }
Step "repository root confirmed"

# --- 2. the version string is well formed ------------------------------------
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "version '$Version' is not X.Y.Z (no leading v, no suffix)"
}
$Tag = "v$Version"
Step "version $Version -> tag $Tag"

# --- 3. the working tree is clean --------------------------------------------
# A dirty tree means the tag would point at a commit that does not match what
# was tested. This is the check that stops "it worked on my machine" shipping.
$dirty = git status --porcelain
if ($dirty) {
    Write-Host ""
    Write-Host $dirty
    Fail "working tree is not clean - commit or stash first"
}
Step "working tree clean"

# --- 4. branch ---------------------------------------------------------------
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main" -and -not $AllowBranch) {
    Fail "on branch '$branch', not main. Re-run with -AllowBranch if this is deliberate."
}
Step "on branch $branch"

# --- 5. the tag must not already exist ---------------------------------------
# Locally...
$existingLocal = git tag --list $Tag
if ($existingLocal) { Fail "tag $Tag already exists locally - versions are immutable, pick a new one" }

# ...and on the remote. A tag that exists there but not here would be silently
# clobbered on push, which is the one way two builds end up sharing a version.
Step "checking remote for $Tag"
$remoteTags = git ls-remote --tags origin $Tag 2>$null
if ($remoteTags) { Fail "tag $Tag already exists on origin - versions are immutable, pick a new one" }
Step "tag $Tag is free"

# --- 6. the version must move forward ----------------------------------------
if (Test-Path "VERSION") {
    $currentRaw = [System.IO.File]::ReadAllText("$PWD\VERSION")
    $current = $currentRaw.Trim()

    if ($current -match '^\d+\.\d+\.\d+$') {
        if ([version]$Version -le [version]$current) {
            Fail "version $Version is not greater than current $current"
        }
        Step "bumping $current -> $Version"
    } else {
        Write-Host "  WARNING: existing VERSION is '$current', which is not X.Y.Z" -ForegroundColor Yellow
        Step "overwriting with $Version"
    }
} else {
    Step "no VERSION file yet - this is the first release"
}

# --- 7. write VERSION: LF, no BOM --------------------------------------------
# PowerShell's echo/> writes UTF-16 with a BOM and CRLF endings. A BOM or CR in
# a version file makes every device compare current != target and reinstall
# forever - it cost the Attitude fleet exactly that. .gitattributes carries
# "VERSION text eol=lf", but the bytes are written correctly here regardless
# rather than relying on git to fix them afterwards.
[System.IO.File]::WriteAllText(
    "$PWD\VERSION",
    "$Version`n",
    (New-Object System.Text.UTF8Encoding($false))
)

$bytes = [System.IO.File]::ReadAllBytes("$PWD\VERSION")
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Fail "VERSION was written with a BOM - refusing to continue"
}
if ($bytes -contains 0x0D) {
    Fail "VERSION contains a CR byte - refusing to continue"
}
Step "VERSION written: $($bytes.Length) bytes, no BOM, no CR"

# --- 8. show the diff before committing --------------------------------------
# Doctrine 2.16: diff before committing. Never commit a file you have not
# looked at as a diff.
git add VERSION
Write-Host ""
Write-Host "--- staged diff ---" -ForegroundColor Cyan
git diff --cached -- VERSION
Write-Host "-------------------" -ForegroundColor Cyan
Write-Host ""

$confirm = Read-Host "Commit and tag as $Tag? (yes/no)"
if ($confirm -ne "yes") {
    git reset HEAD VERSION | Out-Null
    Fail "cancelled - VERSION left modified in the working tree, nothing staged"
}

# --- 9. commit and tag -------------------------------------------------------
git commit -m "Release $Version"
if ($LASTEXITCODE -ne 0) { Fail "commit failed" }
Step "committed"

git tag $Tag
if ($LASTEXITCODE -ne 0) { Fail "tag failed - the commit was made but is untagged, fix by hand" }
Step "tagged $Tag"

$sha = (git rev-parse --short HEAD).Trim()

# --- 10. stop. pushing is a separate deliberate act --------------------------
Write-Host ""
Write-Host "Release $Version prepared locally at $sha (tag $Tag)." -ForegroundColor Green
Write-Host ""
Write-Host "NOT PUSHED. Pushing main is the deploy action for this repo." -ForegroundColor Yellow
Write-Host "When you are ready:"
Write-Host ""
Write-Host "    git push origin $branch"
Write-Host "    git push origin $Tag"
Write-Host ""
Write-Host "Push the branch BEFORE the tag: a tag on the remote pointing at a" -ForegroundColor DarkGray
Write-Host "commit the remote does not have is a release nothing can install." -ForegroundColor DarkGray
Write-Host ""
