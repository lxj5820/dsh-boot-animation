# install.ps1 - install dsh-boot-animation into a DSH profile.
#
# This is the version to hand to somebody else: nothing here is tied to the
# author's machine. Every path is either derived from this script's own location
# or from the environment, and the script stops with a clear message when it
# cannot find what it needs rather than writing somewhere unexpected.
#
# What it does:
#   1. a directory link at <profile>\node_modules\dsh-boot-animation
#   2. one appended row in <profile>\cordis.patch.yml
# It does NOT touch package.json, does NOT run pnpm, and does NOT restart dsh.
#
# A profile whose package.json says `dsh.profile.patchReload: "live"` (the
# default when the field is absent) gets a Cordis HMR watcher on cordis.patch.yml,
# so the change is picked up without a restart. Profiles that opt out of live
# patching need a restart instead - the script says so and stops.
#
# Undo with uninstall.ps1, or by deleting the row it appends.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes a BOM-less file as the
# system ANSI codepage, and CJK bytes can terminate a string literal.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileName web
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome C:\Users\me\.dsh
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Port 19387
#
# The final check asks whether a dsh web server is still answering, and it has to
# guess the port: `dsh web` defaults to 3080, while the DESKTOP app serves on a
# different one (19387 on the machine this was measured on, printed in the window's
# URL) and no file records it. Guessing one port made the check report FAILED for a
# perfectly good install, which then rolled the whole thing back. So a list of
# candidates is probed and the first one that answers is the one that counts.

param(
  [string]$PackageDir = (Split-Path $PSScriptRoot -Parent),
  [string]$DshHome = '',
  [string]$ProfileName = 'web',
  [int[]]$Ports = @(3080, 19387),
  [int]$Port = 0
)

# -Port <n> is the documented single-port form; let it win when it is passed.
if ($Port -gt 0) { $Ports = @($Port) }

$ErrorActionPreference = 'Continue'
$PluginName = 'dsh-boot-animation'

function Say($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') $m" }
function Fail($m) { Say "FAILED: $m"; exit 2 }

# The patch layer is BOM-less UTF-8 and routinely carries CJK (a provider's
# displayName, a comment). Both the read and the write below therefore go through
# .NET's UTF-8 codec: `Get-Content` without -Encoding decodes it as the system
# ANSI codepage on PowerShell 5.1, and `Set-Content -Encoding utf8` there means
# UTF-8 WITH a BOM. Either one is a change to a file this script does not own.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# How many insert blocks in the patch layer declare this plugin with the three
# lines this script writes and uninstall.ps1 removes.
#
# Counting them is not the same as searching the file for the plugin name. Once
# the settings card has saved a value, the settings service writes a row of its
# own into this file - `- id: boot-animation` with a `config:` block and no
# `insert:`. That row mounts nothing, but a name search sees it, concludes
# "already installed", and leaves the plugin off the loader graph while reporting
# success. tools/install.sh counts insert rows for exactly this reason.
function Get-InsertRowCount([string]$path) {
  $raw = [System.IO.File]::ReadAllText($path, $Utf8NoBom)
  $eol = '(?:\r\n|\n|\r)'
  $idLine = '[ \t]*-[ \t]*id:[ \t]*boot-animation[ \t]*'
  $nameLine = '[ \t]*name:[ \t]*' + [regex]::Escape($PluginName) + '[ \t]*'
  # One line, deliberately. PowerShell does NOT continue after a trailing `+`
  # when the statement is already complete: `$a = 'x' + $b` ends there, and a
  # following line starting with `+` becomes a unary plus that throws at runtime -
  # swallowed by $ErrorActionPreference = 'Continue', leaving a pattern that is
  # silently half-built and matches the wrong row.
  $pattern = '(?m)^[ \t]*-[ \t]*insert:[ \t]*' + $eol + $idLine + $eol + $nameLine
  return ([regex]::Matches($raw, $pattern)).Count
}

# --- where are we -----------------------------------------------------------
if (-not (Test-Path (Join-Path $PackageDir 'package.json'))) {
  Fail "the package was not found at '$PackageDir'. Pass -PackageDir <dir>."
}
if (-not (Test-Path (Join-Path $PackageDir 'entry.js'))) {
  Fail "'$PackageDir' has no entry.js - that does not look like this package."
}

# --- where is dsh -----------------------------------------------------------
if ($DshHome -eq '') {
  if ($env:DSH_HOME -ne '' -and $null -ne $env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  elseif ($env:USERPROFILE -ne '' -and $null -ne $env:USERPROFILE) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
  else { Fail 'cannot guess the DSH home; pass -DshHome <dir>.' }
}
if (-not (Test-Path $DshHome)) { Fail "no DSH home at '$DshHome'; pass -DshHome <dir>." }

$Profile = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$PatchFile = Join-Path $Profile 'cordis.patch.yml'
$ProfileManifest = Join-Path $Profile 'package.json'
$LinkPath = Join-Path $Profile "node_modules\$PluginName"
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = Join-Path $DshHome ".dsh-rollback-$PluginName-$Stamp"

Say '=== 0/5 preconditions ==='
Say "  package : $PackageDir"
Say "  dsh home: $DshHome"
Say "  profile : $Profile"
if (-not (Test-Path $ProfileManifest)) {
  $found = @()
  $profilesDir = Join-Path $DshHome 'profiles'
  if (Test-Path $profilesDir) {
    $found = @(Get-ChildItem $profilesDir -Directory | ForEach-Object { $_.Name })
  }
  Fail "no profile at '$Profile'. Profiles present: $($found -join ', '). Pass -ProfileName <name>."
}
if (-not (Test-Path $PatchFile)) { Fail "no cordis.patch.yml at '$PatchFile'." }

$manifest = Get-Content $ProfileManifest -Raw | ConvertFrom-Json
# An absent field is NOT "not live": the loader resolves it to a default of 'live'.
$reload = $manifest.dsh.profile.patchReload
if ($null -eq $reload -or $reload -eq '') { $reload = 'live (default, field absent)' }
if ($reload -notmatch '^live') {
  Say "  patchReload = $reload"
  Say '  This profile does not hot-reload its patch layer, so the row below would only'
  Say '  take effect after a restart. That is fine - just restart dsh yourself when the'
  Say '  script finishes. Continuing.'
}

if ($manifest.dsh.profile.bundles -contains $PluginName) {
  Say '  already declared as a bundle layer; a patch row would mount it twice.'
  Say '  Nothing to do.'
  exit 0
}

Say '=== 1/5 back up the patch layer ==='
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
Copy-Item $PatchFile (Join-Path $Backup 'cordis.patch.yml') -Force
"hadNodeModulesLink=$(Test-Path $LinkPath)" | Set-Content (Join-Path $Backup 'MANIFEST.txt') -Encoding ascii
Say "  backup = $Backup"

Say '=== 2/5 link the package into the profile ==='
if (Test-Path $LinkPath) {
  Say '  link already present'
} else {
  New-Item -ItemType Junction -Path $LinkPath -Target $PackageDir -Force | Out-Null
  Say "  linked $LinkPath -> $PackageDir"
}

# The settings card needs a schema, which comes from @deepseek-ai/schemastery, and
# it needs a copy that actually has `Schema.prototype.volatile`: `dsh-settings`
# serves a namespace only for an entry whose Config projects a form, and that
# projection keeps volatile fields alone. An older copy without the method makes
# entry.js degrade (it warns instead of throwing, so the animation still runs), and
# the Settings card then never appears with nothing else to look at.
#
# The kernel's own copy (3.18.4+) lives inside the app payload, which Node cannot
# resolve, so this script must find a real directory. A package that already
# carries a good copy keeps it; otherwise the first GOOD candidate among the
# profile's own links is used. A candidate that is present but too old is refused
# by name, because linking it is exactly the silent failure this step exists to
# prevent - that is how a workspace checkout's 3.18.1 build gets picked up.
$SchemaName = '@deepseek-ai\schemastery'
$SchemaLink = Join-Path $PackageDir "node_modules\$SchemaName"

# Minimum copy that has Schema.prototype.volatile.
$SchemaMinVersion = [version]'3.18.4'

function Get-SchemaVersion([string]$dir) {
  $manifest = Join-Path $dir 'package.json'
  if (-not (Test-Path $manifest)) { return $null }
  try {
    $parsed = Get-Content $manifest -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
  if ($parsed.name -ne '@deepseek-ai/schemastery' -or $null -eq $parsed.version) { return $null }
  try { return [version]$parsed.version } catch { return $null }
}

if (Test-Path $SchemaLink) {
  $present = Get-SchemaVersion $SchemaLink
  if ($null -ne $present -and $present -ge $SchemaMinVersion) {
    Say "  schema dependency already present ($present)"
  } elseif ($null -eq $present) {
    Say "  WARNING: $SchemaLink exists but does not read as @deepseek-ai/schemastery."
    Say '  The animation will work, but the Settings card may NOT appear.'
    Say '  Point it at a copy of the schema package (3.18.4 or newer) and install again.'
  } else {
    Say "  WARNING: the linked schema dependency is $present, which has no .volatile()."
    Say '  The animation will work, but the Settings card will NOT appear.'
    Say "  Remove $SchemaLink and install again with a 3.18.4-or-newer copy in reach."
  }
} else {
  $candidates = @(
    (Join-Path $Profile "node_modules\$SchemaName"),
    (Join-Path (Join-Path $DshHome 'profiles') "node_modules\$SchemaName")
  )
  $source = ''
  $rejected = @()
  foreach ($candidate in $candidates) {
    if (-not (Test-Path $candidate)) { continue }
    $found = Get-SchemaVersion $candidate
    if ($null -ne $found -and $found -ge $SchemaMinVersion) { $source = $candidate; break }
    $shown = if ($null -eq $found) { 'unreadable version' } else { "$found" }
    $rejected += "$candidate ($shown)"
  }
  if ($source -eq '') {
    Say '  WARNING: no usable @deepseek-ai/schemastery was found (need 3.18.4 or newer).'
    Say '  The animation will work, but the Settings card will NOT appear.'
    if ($rejected.Count -gt 0) {
      Say '  Refused, because an older copy silently hides the card:'
      foreach ($row in $rejected) { Say "    $row" }
    }
    Say '  To fix it, put the copy the kernel loads (3.18.4+) at:'
    Say "    $SchemaLink"
    Say "  (looked in: $($candidates -join ' ; '))"
  } else {
    New-Item -ItemType Directory -Force -Path (Join-Path $PackageDir 'node_modules\@deepseek-ai') | Out-Null
    New-Item -ItemType Junction -Path $SchemaLink -Target $source -Force | Out-Null
    Say "  linked schema dependency -> $source"
  }
}

Say '=== 3/5 append the plugin row to the patch layer ==='
$rows = Get-InsertRowCount $PatchFile
if ($rows -gt 0) {
  Say "  an insert row for this plugin is already there ($rows of them); leaving it alone"
} else {
  # Written with .NET rather than Add-Content: `-Encoding utf8` means different
  # things on PowerShell 5.1 and 7, and the appended block must neither add a BOM
  # nor normalise the line endings of a file this script does not own. The block
  # uses the terminator the file already uses, so the style stays uniform, and it
  # ends on its own newline instead of leaving a blank line behind.
  $raw = [System.IO.File]::ReadAllText($PatchFile, $Utf8NoBom)
  $newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
  $block = '- insert:' + $newline + '    - id: boot-animation' + $newline + '      name: ' + $PluginName + $newline
  if ($raw.Length -gt 0 -and -not $raw.EndsWith("`n") -and -not $raw.EndsWith("`r")) {
    $raw += $newline
  }
  [System.IO.File]::WriteAllText($PatchFile, $raw + $block, $Utf8NoBom)
  Say '  appended 3 lines'
  if ($raw -match [regex]::Escape($PluginName)) {
    Say '  note: the layer already carried this plugin name without an insert row'
    Say '        (a config override, e.g. settings the card saved); it is left as it is.'
  }
}

Say '=== 4/5 tell dsh to pick it up ==='
Say '  live profiles notice the file change within a few seconds.'
Say '  If this profile does not hot-reload, restart dsh now.'
Start-Sleep -Seconds 6

Say '=== 5/5 is the service still answering ==='
# Any HTTP status counts as an answer: 401 is the normal one (the root needs the
# launch token the printed URL carries), 200 means a deployment without the token
# gate. This is a liveness check, not an authorisation check, so it must not
# demand one particular code.
$answered = ''
$answeredPort = 0
$curlOk = $true
foreach ($candidate in $Ports) {
  for ($i = 1; $i -le 8; $i++) {
    $code = curl.exe -s -o NUL -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$candidate/" 2>$null
    if ($LASTEXITCODE -ne 0 -and ($code -eq '' -or $code -eq '000')) {
      # curl itself failed. That is this machine refusing the tool, not the server
      # refusing the connection, and the difference decides what to tell the user.
      if ($null -eq (Get-Command curl.exe -ErrorAction SilentlyContinue)) { $curlOk = $false }
    }
    if ($code -ne '' -and $code -ne '000') { $answered = $code; $answeredPort = $candidate; break }
    Start-Sleep -Seconds 2
  }
  if ($answered -ne '') { break }
}
if ($answered -ne '') { Say "  port $answeredPort answers: $answered" } else { Say '  no port answered' }

if ($answered -ne '') {
  Say ''
  Say 'DONE. Open dsh in the browser and refresh.'
  Say 'What this check cannot tell you: whether the overlay actually rendered. The page'
  Say 'needs the launch token, which only the printed URL carries. A deep-sea screen'
  Say 'means it works; the plain HARNESS page means it did not take (restart dsh).'
  Say 'Settings card: Settings -> Plugins -> Plugin configuration, then the row'
  Say 'whose name is written in Chinese (see MANUAL.md for the exact wording).'
  Say "Undo: powershell -ExecutionPolicy Bypass -File $(Join-Path $PackageDir 'tools\uninstall.ps1')"
  Say "Backup: $Backup"
  exit 0
}

Say ''
Say 'WARNING: no dsh web server answered on any of these ports:'
Say "  $($Ports -join ', ')"
Say 'The plugin row and the link are IN PLACE - they have not been rolled back, because'
Say 'this check cannot tell a dsh server that is down from a dsh server on a port that'
Say 'was not tried. The desktop app prints its own port in the window URL; find it there'
Say 'and re-run this script with -Port <that number> to get a real answer.'
if (-not $curlOk) {
  Say 'curl.exe was not usable here. This is the check failing, not necessarily the'
  Say 'install: run the same port by hand with any HTTP client.'
}
Say 'If dsh is NOT running, start it: the animation shows on the next page load.'
Say "Backup: $Backup"
