# uninstall.ps1 - remove dsh-boot-animation from a DSH profile.
#
# The inverse of install.ps1: drop the patch row this plugin appended, and remove
# the directory link it created. The package directory itself is never deleted, and
# nothing else in the patch layer is touched.
#
# Paths are derived the same way install.ps1 derives them, so this works on any
# machine.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes a BOM-less file as the
# system ANSI codepage, and CJK bytes can terminate a string literal.
#
# The same decoding rule governs cordis.patch.yml, and there it is destructive.
# The patch layer is BOM-less UTF-8 and routinely carries CJK - a provider's
# displayName, a comment - while `Get-Content` without -Encoding decodes it as the
# ANSI codepage and `Set-Content -Encoding utf8` writes the mangled text back plus
# a BOM. Measured on a real profile: `displayName: <two CJK chars>` came back as
# four unrelated characters and the file grew a BOM. The patch layer is the user's,
# not this plugin's, so both operations below go through .NET's UTF-8 codec, which
# decodes correctly and writes no BOM. That is the whole reason this script does
# not simply use Get-Content/Set-Content.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -ProfileName web

param(
  [string]$PackageDir = (Split-Path $PSScriptRoot -Parent),
  [string]$DshHome = '',
  [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Continue'
$PluginName = 'dsh-boot-animation'

function Say($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') $m" }
function Fail($m) { Say "FAILED: $m"; exit 2 }

# The patch layer is UTF-8 without a BOM, and must stay exactly that way.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-Lines([string]$path) {
  return @([System.IO.File]::ReadAllLines($path, $Utf8NoBom))
}

function Set-Lines([string]$path, [string[]]$lines) {
  [System.IO.File]::WriteAllLines($path, $lines, $Utf8NoBom)
}

if ($DshHome -eq '') {
  if ($env:DSH_HOME -ne '' -and $null -ne $env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  elseif ($env:USERPROFILE -ne '' -and $null -ne $env:USERPROFILE) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
  else { Fail 'cannot guess the DSH home; pass -DshHome <dir>.' }
}

$Profile = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$PatchFile = Join-Path $Profile 'cordis.patch.yml'
$LinkPath = Join-Path $Profile "node_modules\$PluginName"
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = Join-Path $DshHome ".dsh-rollback-$PluginName-undo-$Stamp"

Say '=== 0/3 preconditions ==='
Say "  profile: $Profile"
if (-not (Test-Path $PatchFile)) { Fail "no cordis.patch.yml at '$PatchFile'." }

Say '=== 1/3 back up the patch layer ==='
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
Copy-Item $PatchFile (Join-Path $Backup 'cordis.patch.yml') -Force
"hadNodeModulesLink=$(Test-Path $LinkPath)" | Set-Content (Join-Path $Backup 'MANIFEST.txt') -Encoding ascii
Say "  backup = $Backup"

Say '=== 2/3 remove the row this plugin appended ==='
$lines = Get-Lines $PatchFile
$kept = @()
$removed = 0
for ($i = 0; $i -lt $lines.Count; $i++) {
  # The block install.ps1 writes is exactly:
  #   - insert:
  #       - id: boot-animation
  #         name: dsh-boot-animation
  # Match it by the row it names, and only when it is this plugin's row.
  if ($lines[$i] -match '^\s*- insert:\s*$' -and
      ($i + 2) -lt $lines.Count -and
      $lines[$i + 1] -match '^\s*- id:\s*boot-animation\s*$' -and
      $lines[$i + 2] -match ('^\s*name:\s*' + [regex]::Escape($PluginName) + '\s*$')) {
    $i += 2
    $removed += 1
    continue
  }
  $kept += $lines[$i]
}
if ($removed -eq 0) {
  Say "  no row for $PluginName found; the patch layer is already clean"
} else {
  Set-Lines $PatchFile $kept
  Say "  removed $removed row(s)"
}

Say '=== 3/3 remove the directory link ==='
# The link is a junction. `Remove-Item -Recurse` on one can prompt for
# confirmation and then fail as "not empty" in a non-interactive shell, so the
# link alone is removed with rmdir, which never follows it into the target.
# Whatever is NOT a reparse point is refused instead of deleted: a real directory
# here would be the user's, and this script may not destroy their data.
if (Test-Path $LinkPath) {
  $item = Get-Item $LinkPath -Force
  $isLink = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  if (-not $isLink) {
    Say "  WARNING: $LinkPath is not a link; refusing to delete it."
    Say '  Remove it yourself if it really is this plugin.'
  } else {
    $null = cmd /c rmdir "$LinkPath" 2>&1
    if (Test-Path $LinkPath) { Say "  WARNING: could not remove $LinkPath" }
    else { Say "  removed $LinkPath" }
  }
} else {
  Say '  no link present'
}

Say ''
Say 'DONE. Restart dsh if this profile does not hot-reload its patch layer.'
Say "Backup: $Backup"
exit 0
