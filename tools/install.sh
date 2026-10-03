#!/bin/sh
# install.sh - install dsh-boot-animation into a DSH profile (macOS / Linux).
#
# The POSIX twin of install.ps1: the same two changes to the profile, the same
# backup, the same checks. Every path is either derived from this script's own
# location or from the environment, and the script stops with a clear message
# when it cannot find what it needs rather than writing somewhere unexpected.
#
# What it does:
#   1. a symlink at <profile>/node_modules/dsh-boot-animation
#   2. one appended row in <profile>/cordis.patch.yml
# It does NOT touch package.json, does NOT run pnpm, and does NOT restart dsh.
#
# A profile whose package.json says `dsh.profile.patchReload: "live"` (the
# default when the field is absent) gets a Cordis HMR watcher on cordis.patch.yml,
# so the change is picked up without a restart. Profiles that opt out of live
# patching still install fine - they just need the restart, and the script says so
# instead of promising a hot reload it cannot deliver.
#
# Undo with uninstall.sh, or by deleting the row it appends.
#
# ASCII-only on purpose, like the .ps1 pair: it stays editable from any platform,
# and the only thing it ever appends is ASCII - the profile file it appends to is
# not this script's own, and is left in whatever encoding it arrived in.
#
# Usage:
#   sh tools/install.sh
#   sh tools/install.sh --profile desktop
#   sh tools/install.sh --dsh-home /home/me/.dsh --package-dir /opt/dsh-boot-animation
#   sh tools/install.sh --port 19387

set -u
LC_ALL=C
export LC_ALL

PLUGIN_NAME='dsh-boot-animation'
PATCH_ID='boot-animation'
SCHEMA_NAME='@deepseek-ai/schemastery'
# Minimum copy that has Schema.prototype.volatile.
SCHEMA_MIN_VERSION='3.18.4'

say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { say "FAILED: $*"; exit 2; }

usage() {
  cat <<'EOF'
usage: sh tools/install.sh [options]

  --package-dir <dir>  the package to install (default: the directory holding
                       this script's parent)
  --dsh-home <dir>     DSH home (default: $DSH_HOME, else $HOME/.dsh)
  --profile <name>     profile to install into (default: web; the desktop app
                       runs `desktop`, and that is not the default)
  --port <n>           probe only this port in the liveness check
  -h, --help           this text
EOF
}

PACKAGE_DIR=''
DSH_HOME_DIR=''
PROFILE='web'
PORT=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package-dir)
      [ "$#" -ge 2 ] || fail '--package-dir needs a value'
      PACKAGE_DIR=$2; shift 2 ;;
    --dsh-home)
      [ "$#" -ge 2 ] || fail '--dsh-home needs a value'
      DSH_HOME_DIR=$2; shift 2 ;;
    --profile)
      [ "$#" -ge 2 ] || fail '--profile needs a value'
      PROFILE=$2; shift 2 ;;
    --port)
      [ "$#" -ge 2 ] || fail '--port needs a value'
      PORT=$2; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      usage >&2; fail "unknown argument '$1'" ;;
  esac
done

# --- where are we -----------------------------------------------------------
if [ -z "$PACKAGE_DIR" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) ||
    fail "cannot resolve the directory this script lives in"
  PACKAGE_DIR=$(dirname -- "$SCRIPT_DIR")
fi
[ -f "$PACKAGE_DIR/package.json" ] || fail "the package was not found at '$PACKAGE_DIR'. Pass --package-dir <dir>."
[ -f "$PACKAGE_DIR/entry.js" ] || fail "'$PACKAGE_DIR' has no entry.js - that does not look like this package."

# Node is what DSH itself runs on, so it is normally here. It is only needed for
# the three checks that read JSON: without it they are skipped with a warning and
# the rest of the install - which is pure shell - still happens.
NODE=$(command -v node 2>/dev/null || true)
CURL=$(command -v curl 2>/dev/null || true)

# --- where is dsh -----------------------------------------------------------
if [ -z "$DSH_HOME_DIR" ]; then
  if [ -n "${DSH_HOME:-}" ]; then
    DSH_HOME_DIR=$DSH_HOME
  elif [ -n "${HOME:-}" ]; then
    DSH_HOME_DIR=$HOME/.dsh
  else
    fail 'cannot guess the DSH home; pass --dsh-home <dir>.'
  fi
fi
[ -d "$DSH_HOME_DIR" ] || fail "no DSH home at '$DSH_HOME_DIR'; pass --dsh-home <dir>."

# A trailing slash would show up in every message below.
DSH_HOME_DIR=${DSH_HOME_DIR%/}
PACKAGE_DIR=${PACKAGE_DIR%/}

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PROFILE_MANIFEST="$PROFILE_DIR/package.json"
LINK_PATH="$PROFILE_DIR/node_modules/$PLUGIN_NAME"
STAMP=$(date '+%Y%m%d-%H%M%S')
BACKUP="$DSH_HOME_DIR/.dsh-rollback-$PLUGIN_NAME-$STAMP"

# --- the two helpers that read JSON -----------------------------------------
# Read one dotted path out of a JSON file; print nothing when it is absent or
# unreadable. `--input-type=commonjs` because the caller's cwd may well be this
# package, whose package.json says `"type": "module"`.
json_field() {
  "$NODE" --input-type=commonjs -e '
    const fs = require("fs");
    let root = null;
    try { root = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(0); }
    let value = root;
    for (const key of process.argv[2].split(".")) {
      if (value === null || typeof value !== "object" || !(key in value)) { value = undefined; break; }
      value = value[key];
    }
    if (value === undefined || value === null) { process.exit(0); }
    process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
  ' "$1" "$2" 2>/dev/null || true
}

# version_ge <a> <b> - exit 0 when a >= b. `sort -V` is GNU-only, so this is done
# where the numbers can actually be compared.
version_ge() {
  "$NODE" --input-type=commonjs -e '
    const num = (s) => String(s).split(/[.\-+]/).map((p) => { const n = parseInt(p, 10); return isNaN(n) ? 0 : n; });
    const a = num(process.argv[1]), b = num(process.argv[2]);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) process.exit(x > y ? 0 : 1);
    }
    process.exit(0);
  ' "$1" "$2" 2>/dev/null || return 1
}

# schema_probe <dir> - print "name|version|marker", where marker is "yes" when the
# copy's own entry file mentions `volatile`. The version is what the decision uses;
# the marker is the same evidence entry.js itself probes for, printed for
# diagnosis (the 3.18.1 build has `volatile` in it zero times).
schema_probe() {
  "$NODE" --input-type=commonjs -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1];
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch (e) { process.exit(1); }
    let marker = "no";
    for (const rel of ["lib/index.mjs", "lib/index.cjs", "lib/index.js"]) {
      try {
        if (fs.readFileSync(path.join(dir, rel), "utf8").includes("volatile")) { marker = "yes"; break; }
      } catch (e) {}
    }
    process.stdout.write([manifest.name || "?", manifest.version || "?", marker].join("|"));
  ' "$1" 2>/dev/null || true
}

# The copy of the schema the `dsh` command itself loads sits beside the CLI's own
# package.json. Worth looking for on this platform: the desktop app keeps its
# kernel inside the application payload, which is exactly the copy INSTALL.md
# tells you to unpack by hand, and the profile's own node_modules often holds an
# older build (or none at all).
dsh_kernel_schema() {
  [ -n "$NODE" ] || return 1
  cli=$(command -v dsh 2>/dev/null) || return 1
  [ -n "$cli" ] || return 1
  hops=0
  while [ -L "$cli" ] && [ "$hops" -lt 16 ]; do
    target=$(readlink "$cli") || return 1
    case $target in
      /*) cli=$target ;;
      *) cli=$(dirname -- "$cli")/$target ;;
    esac
    hops=$((hops + 1))
  done
  dir=$(CDPATH= cd -- "$(dirname -- "$cli")" && pwd -P) || return 1
  while [ "$dir" != '/' ] && [ -n "$dir" ]; do
    if [ -f "$dir/package.json" ]; then
      printf '%s\n' "$dir/node_modules/$SCHEMA_NAME"
      return 0
    fi
    dir=$(dirname -- "$dir")
  done
  return 1
}

# link_to <target> <link-path> - replace a symlink, create one, and refuse to
# touch anything that is not a symlink (a real directory there is the user's).
link_to() {
  if [ -L "$2" ]; then
    rm -f "$2" || return 1
  elif [ -e "$2" ]; then
    return 1
  fi
  ln -s "$1" "$2"
}

# insert_rows <patch-file> - how many blocks in the patch layer declare this
# plugin with the three lines this script appends, which are the same three lines
# uninstall.sh removes. Counting them is what keeps "what install adds" and "what
# uninstall takes away" the same thing. A bare mention of the name is not enough:
# the settings service writes an id-targeted config-override row of its own
# (`- id: boot-animation` with a `config:` block, no `insert:`), and that row
# mounts nothing on its own - treating it as "already installed" would leave the
# plugin off the graph. Prints nothing readable when the file cannot be parsed.
insert_rows() {
  awk -v id="$PATCH_ID" -v name="$PLUGIN_NAME" '
    { line[NR] = $0 }
    END {
      found = 0
      for (i = 1; i + 2 <= NR; i++) {
        if (line[i] ~ /^[[:space:]]*-[[:space:]]*insert:[[:space:]]*$/ &&
            line[i + 1] ~ ("^[[:space:]]*-[[:space:]]*id:[[:space:]]*" id "[[:space:]]*$") &&
            line[i + 2] ~ ("^[[:space:]]*name:[[:space:]]*" name "[[:space:]]*$")) found += 1
      }
      print found
    }
  ' "$1" 2>/dev/null
}

# block_candidates <patch-file> - the places the kernel's own copy of the schema
# may be: the profile's node_modules first (that is what install.ps1 links), then
# the shared profiles/node_modules, then the kernel's own tree.
block_candidates() {
  printf '%s\n' \
    "$PROFILE_DIR/node_modules/$SCHEMA_NAME" \
    "$DSH_HOME_DIR/profiles/node_modules/$SCHEMA_NAME"
  dsh_kernel_schema || true
}

say '=== 0/5 preconditions ==='
say "  package : $PACKAGE_DIR"
say "  dsh home: $DSH_HOME_DIR"
say "  profile : $PROFILE_DIR"
if [ ! -f "$PROFILE_MANIFEST" ]; then
  found=''
  if [ -d "$DSH_HOME_DIR/profiles" ]; then
    for entry in "$DSH_HOME_DIR"/profiles/*; do
      [ -d "$entry" ] || continue
      name=${entry##*/}
      found="$found${found:+, }$name"
    done
  fi
  fail "no profile at '$PROFILE_DIR'. Profiles present: ${found:-none}. Pass --profile <name>."
fi
[ -f "$PATCH_FILE" ] || fail "no cordis.patch.yml at '$PATCH_FILE'."

if [ -z "$NODE" ]; then
  say '  WARNING: node was not found on PATH, so the profile manifest could not be read.'
  say '  Skipping the bundle-layer and patchReload checks; they are diagnostics.'
  say '  DSH needs Node (^22.19.0 || >=24) to run at all, so it is usually here.'
else
  # An absent field is NOT "not live": the loader resolves it to a default of 'live'.
  reload=$(json_field "$PROFILE_MANIFEST" 'dsh.profile.patchReload')
  if [ -z "$reload" ]; then
    reload='live (default, field absent)'
  fi
  case $reload in
    live*) ;;
    *)
      say "  patchReload = $reload"
      say '  This profile does not hot-reload its patch layer, so the row below would only'
      say '  take effect after a restart. That is fine - just restart dsh yourself when the'
      say '  script finishes. Continuing.' ;;
  esac

  bundles=$(json_field "$PROFILE_MANIFEST" 'dsh.profile.bundles')
  case $bundles in
    *\"$PLUGIN_NAME\"*)
      say '  already declared as a bundle layer; a patch row would mount it twice.'
      say '  Nothing to do.'
      exit 0 ;;
  esac
fi

say '=== 1/5 back up the patch layer ==='
mkdir -p "$BACKUP" || fail "cannot create the backup directory '$BACKUP'."
cp "$PATCH_FILE" "$BACKUP/cordis.patch.yml" || fail "cannot copy '$PATCH_FILE' into the backup."
if [ -e "$LINK_PATH" ]; then
  printf 'hadNodeModulesLink=True\n' > "$BACKUP/MANIFEST.txt"
else
  printf 'hadNodeModulesLink=False\n' > "$BACKUP/MANIFEST.txt"
fi
say "  backup = $BACKUP"

say '=== 2/5 link the package into the profile ==='
if [ -e "$LINK_PATH" ] || [ -L "$LINK_PATH" ]; then
  if [ -L "$LINK_PATH" ]; then
    say "  link already present -> $(readlink "$LINK_PATH")"
  else
    say "  WARNING: $LINK_PATH exists and is not a symlink; leaving it alone."
    say '  If it is not this package, remove it and install again.'
  fi
else
  mkdir -p "$PROFILE_DIR/node_modules" || fail "cannot create '$PROFILE_DIR/node_modules'."
  link_to "$PACKAGE_DIR" "$LINK_PATH" || fail "cannot create the link at '$LINK_PATH'."
  say "  linked $LINK_PATH -> $PACKAGE_DIR"
fi

# The settings card needs a schema, which comes from @deepseek-ai/schemastery, and
# it needs a copy that actually has `Schema.prototype.volatile`: `dsh-settings`
# serves a namespace only for an entry whose Config projects a form, and that
# projection keeps volatile fields alone. An older copy without the method makes
# entry.js degrade (it warns instead of throwing, so the animation still runs), and
# the Settings card then never appears with nothing else to look at.
#
# The kernel's own copy lives inside the app payload, which Node cannot resolve,
# so this script must find a real directory. A package that already carries a good
# copy keeps it; otherwise the first GOOD candidate is linked. A candidate that is
# present but too old is refused by name, because linking it is exactly the silent
# failure this step exists to prevent - that is how a workspace checkout's 3.18.1
# build gets picked up.
SCHEMA_LINK="$PACKAGE_DIR/node_modules/$SCHEMA_NAME"
if [ -z "$NODE" ]; then
  if [ -e "$SCHEMA_LINK" ]; then
    say "  schema dependency already present"
  else
    say "  WARNING: node was not found on PATH, so no schema copy could be checked."
    say '  The animation will work, but the Settings card may NOT appear.'
    say "  Point $SCHEMA_LINK at a copy of the schema package (3.18.4 or newer)"
    say '  and install again.'
  fi
elif [ -e "$SCHEMA_LINK" ] || [ -L "$SCHEMA_LINK" ]; then
  probed=$(schema_probe "$SCHEMA_LINK")
  version=${probed#*|}
  version=${version%%|*}
  marker=${probed##*|}
  if [ -n "$version" ] && version_ge "$version" "$SCHEMA_MIN_VERSION"; then
    say "  schema dependency already present ($version, volatile: $marker)"
  elif [ -z "$probed" ]; then
    say "  WARNING: $SCHEMA_LINK exists but does not read as $SCHEMA_NAME."
    say '  The animation will work, but the Settings card may NOT appear.'
    say '  Point it at a copy of the schema package (3.18.4 or newer) and install again.'
  else
    say "  WARNING: the linked schema dependency is $version, which has no .volatile()."
    say '  The animation will work, but the Settings card will NOT appear.'
    say "  Remove $SCHEMA_LINK and install again with a 3.18.4-or-newer copy in reach."
  fi
else
  source_dir=''
  rejected=''
  looked=''
  for candidate in $(block_candidates); do
    looked="$looked${looked:+ ; }$candidate"
    if [ ! -e "$candidate" ]; then
      continue
    fi
    probed=$(schema_probe "$candidate")
    if [ -z "$probed" ]; then
      rejected="$rejected${rejected:+
}    $candidate (unreadable version)"
      continue
    fi
    version=${probed#*|}
    version=${version%%|*}
    if version_ge "$version" "$SCHEMA_MIN_VERSION"; then
      source_dir=$candidate
      break
    fi
    rejected="$rejected${rejected:+
}    $candidate ($version)"
  done
  if [ -z "$source_dir" ]; then
    say "  WARNING: no usable $SCHEMA_NAME was found (need $SCHEMA_MIN_VERSION or newer)."
    say '  The animation will work, but the Settings card will NOT appear.'
    if [ -n "$rejected" ]; then
      say '  Refused, because an older copy silently hides the card:'
      printf '%s\n' "$rejected"
    fi
    say '  To fix it, put the copy the kernel loads (3.18.4+) at:'
    say "    $SCHEMA_LINK"
    say "  (looked in: $looked)"
  else
    mkdir -p "$PACKAGE_DIR/node_modules/@deepseek-ai" ||
      fail 'cannot create the package node_modules directory; the patch layer was not touched.'
    link_to "$source_dir" "$SCHEMA_LINK" ||
      fail "cannot create the link at '$SCHEMA_LINK'; the patch layer was not touched."
    say "  linked schema dependency -> $source_dir"
  fi
fi

say '=== 3/5 append the plugin row to the patch layer ==='
rows=$(insert_rows "$PATCH_FILE")
case $rows in
  ''|*[!0-9]*)
    fail "cannot read the patch layer at '$PATCH_FILE'."
    ;;
esac
if [ "$rows" -gt 0 ]; then
  say "  an insert row for this plugin is already there ($rows of them); leaving it alone"
else
  # A file whose last line has no newline would glue the new row onto it, so make
  # sure the row starts on a line of its own. Only a byte is added, and only when
  # the file was already missing that newline.
  if [ -s "$PATCH_FILE" ] && [ "$(tail -c 1 "$PATCH_FILE" | wc -l)" -eq 0 ]; then
    printf '\n' >> "$PATCH_FILE" || fail "cannot append to '$PATCH_FILE'."
  fi
  printf -- '- insert:\n    - id: %s\n      name: %s\n' "$PATCH_ID" "$PLUGIN_NAME" >> "$PATCH_FILE" ||
    fail "cannot append to '$PATCH_FILE'."
  say '  appended 3 lines'
  if grep -q -- "$PLUGIN_NAME" "$PATCH_FILE" 2>/dev/null; then
    say '  note: the layer already carried this plugin name without an insert row'
    say '        (a config override, e.g. settings the card saved); it is left as it is.'
  fi
fi

say '=== 4/5 tell dsh to pick it up ==='
say '  live profiles notice the file change within a few seconds.'
say '  If this profile does not hot-reload, restart dsh now.'

say '=== 5/5 is the service still answering ==='
# A liveness check, not an authorisation check: any HTTP status means something
# answered. `dsh web` serves 3080; the desktop app picks its own port and prints
# it in the window URL, which nothing on disk records - hence the candidate list.
if [ -z "$CURL" ]; then
  say '  curl was not found on PATH; skipping the probe'
  code=''
  tried=''
else
  if [ -n "$PORT" ]; then
    ports=$PORT
  else
    ports='3080 19387'
  fi
  tried=$ports
  code='000'
  round=1
  while [ "$round" -le 10 ]; do
    for candidate in $ports; do
      code=$("$CURL" -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 3 "http://127.0.0.1:$candidate/" 2>/dev/null || printf '000')
      [ -n "$code" ] || code='000'
      if [ "$code" != '000' ]; then
        break
      fi
    done
    if [ "$code" != '000' ]; then
      break
    fi
    round=$((round + 1))
    sleep 2
  done
  say "  root answers: $code (ports tried: $tried)"
fi

say ''
if [ "$code" != '000' ] && [ -n "$code" ]; then
  say 'DONE. Open dsh in the browser and refresh.'
else
  say 'DONE, but nothing answered on 127.0.0.1 (ports tried: ${tried:-none}).'
  say 'That is not proof the install failed: a desktop app serves on its own port'
  say '(pass --port <n>, the number is in the URL the app printed) and a stopped'
  say 'dsh answers nothing at all. What was installed is left in place - undo it'
  say 'below if you want it gone.'
fi
say 'What this check cannot tell you: whether the overlay actually rendered. The page'
say 'needs the launch token, which only the printed URL carries. A deep-sea screen'
say 'means it works; the plain HARNESS page means it did not take (restart dsh).'
say 'Settings card: Settings -> Plugins -> Plugin configuration, then the row'
say 'whose name is written in Chinese (see MANUAL.md for the exact wording).'
say "Undo: sh $(dirname -- "$0")/uninstall.sh --profile $PROFILE"
say "Backup: $BACKUP"
exit 0
