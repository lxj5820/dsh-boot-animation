#!/bin/sh
# uninstall.sh - remove dsh-boot-animation from a DSH profile (macOS / Linux).
#
# The inverse of install.sh, and the POSIX twin of uninstall.ps1: drop the patch
# row this plugin appended, and remove the directory link it created. The package
# directory itself is never deleted, and nothing else in the patch layer is
# touched.
#
# Paths are derived the same way install.sh derives them, so this works on any
# machine. ASCII-only on purpose, like the .ps1 pair.
#
# Usage:
#   sh tools/uninstall.sh
#   sh tools/uninstall.sh --profile desktop
#   sh tools/uninstall.sh --dsh-home /home/me/.dsh --profile web

set -u
LC_ALL=C
export LC_ALL

PLUGIN_NAME='dsh-boot-animation'
PATCH_ID='boot-animation'

say() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { say "FAILED: $*"; exit 2; }

usage() {
  cat <<'EOF'
usage: sh tools/uninstall.sh [options]

  --dsh-home <dir>     DSH home (default: $DSH_HOME, else $HOME/.dsh)
  --profile <name>     profile to remove it from (default: web; the desktop app
                       runs `desktop`)
  -h, --help           this text
EOF
}

DSH_HOME_DIR=''
PROFILE='web'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dsh-home)
      [ "$#" -ge 2 ] || fail '--dsh-home needs a value'
      DSH_HOME_DIR=$2; shift 2 ;;
    --profile)
      [ "$#" -ge 2 ] || fail '--profile needs a value'
      PROFILE=$2; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      usage >&2; fail "unknown argument '$1'" ;;
  esac
done

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
DSH_HOME_DIR=${DSH_HOME_DIR%/}

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
LINK_PATH="$PROFILE_DIR/node_modules/$PLUGIN_NAME"
STAMP=$(date '+%Y%m%d-%H%M%S')
BACKUP="$DSH_HOME_DIR/.dsh-rollback-$PLUGIN_NAME-undo-$STAMP"

say '=== 0/3 preconditions ==='
say "  dsh home: $DSH_HOME_DIR"
say "  profile : $PROFILE_DIR"
if [ ! -f "$PATCH_FILE" ]; then
  found=''
  if [ -d "$DSH_HOME_DIR/profiles" ]; then
    for entry in "$DSH_HOME_DIR"/profiles/*; do
      [ -d "$entry" ] || continue
      name=${entry##*/}
      found="$found${found:+, }$name"
    done
  fi
  fail "no cordis.patch.yml at '$PATCH_FILE'. Profiles present: ${found:-none}. Pass --profile <name>."
fi

say '=== 1/3 back up the patch layer ==='
mkdir -p "$BACKUP" || fail "cannot create the backup directory '$BACKUP'."
cp "$PATCH_FILE" "$BACKUP/cordis.patch.yml" || fail "cannot copy '$PATCH_FILE' into the backup."
if [ -e "$LINK_PATH" ] || [ -L "$LINK_PATH" ]; then
  printf 'hadNodeModulesLink=True\n' > "$BACKUP/MANIFEST.txt"
else
  printf 'hadNodeModulesLink=False\n' > "$BACKUP/MANIFEST.txt"
fi
say "  backup = $BACKUP"

say '=== 2/3 remove the row this plugin appended ==='
# The block install.sh writes is exactly:
#   - insert:
#       - id: boot-animation
#         name: dsh-boot-animation
# Match it by the row it names, and only when it is this plugin's row. The rewrite
# keeps every other byte of the original: it is a line deletion, not a YAML
# re-serialisation, so comments, quoting and line endings survive untouched.
REWRITTEN="$BACKUP/cordis.patch.yml.rewritten"
REPORT="$BACKUP/removal.txt"
if ! awk -v report="$REPORT" -v id="$PATCH_ID" -v name="$PLUGIN_NAME" '
  { line[NR] = $0 }
  END {
    i = 1
    while (i <= NR) {
      # [[:space:]] rather than [ \t] so a CRLF file written by uninstall.ps1 on
      # Windows still matches here.
      if (line[i] ~ /^[[:space:]]*-[[:space:]]*insert:[[:space:]]*$/ &&
          i + 2 <= NR &&
          line[i + 1] ~ ("^[[:space:]]*-[[:space:]]*id:[[:space:]]*" id "[[:space:]]*$") &&
          line[i + 2] ~ ("^[[:space:]]*name:[[:space:]]*" name "[[:space:]]*$")) {
        removed += 1
        removedBytes += length(line[i]) + length(line[i + 1]) + length(line[i + 2]) + 3
        i += 3
        continue
      }
      print line[i]
      i += 1
    }
    print removed, removedBytes > report
    close(report)
  }
' "$PATCH_FILE" > "$REWRITTEN" 2>/dev/null; then
  fail "cannot rewrite '$PATCH_FILE'."
fi
removed=$(cut -d' ' -f1 < "$REPORT" 2>/dev/null || printf '')
removed_bytes=$(cut -d' ' -f2 < "$REPORT" 2>/dev/null || printf '')
original_bytes=$(wc -c < "$PATCH_FILE" | tr -d ' ')
rewritten_bytes=$(wc -c < "$REWRITTEN" | tr -d ' ')
if [ "${removed:-0}" = '0' ]; then
  say "  no row for $PLUGIN_NAME found; the patch layer is already clean"
  rm -f "$REWRITTEN" "$REPORT"
else
  # The one invariant worth asserting before the rewrite goes back: the bytes that
  # left the file are exactly the bytes of the rows that were matched. If anything
  # else were dropped or mangled, this does not add up. The only benign mismatch is
  # one byte, and only when a final newline was missing (awk gives every line it
  # prints a newline) - that case is reported rather than failed.
  expected=$((rewritten_bytes + removed_bytes))
  if [ "$expected" -eq "$original_bytes" ]; then
    cat "$REWRITTEN" > "$PATCH_FILE" || fail "cannot write '$PATCH_FILE'."
    rm -f "$REWRITTEN" "$REPORT"
    say "  removed $removed row(s) ($removed_bytes bytes); everything else is byte-identical"
  elif [ "$((expected - 1))" -eq "$original_bytes" ] &&
       [ "$(tail -c 1 "$BACKUP/cordis.patch.yml" | wc -l | tr -d ' ')" = '0' ]; then
    cat "$REWRITTEN" > "$PATCH_FILE" || fail "cannot write '$PATCH_FILE'."
    rm -f "$REWRITTEN" "$REPORT"
    say "  removed $removed row(s); the file had no final newline, which is now added"
  else
    say "  WARNING: the rewrite did not account for every byte"
    say "    $PATCH_FILE   : $original_bytes bytes"
    say "    kept          : $rewritten_bytes bytes"
    say "    removed rows  : $removed_bytes bytes in $removed row(s)"
    say '  The patch layer is left exactly as it was; nothing was written.'
    say "  The version this script would have written is at $REWRITTEN if you want to diff it,"
    say "  and the untouched original is in the backup beside it."
  fi
fi

say '=== 3/3 remove the directory link ==='
if [ -L "$LINK_PATH" ]; then
  target=$(readlink "$LINK_PATH")
  rm -f "$LINK_PATH" || fail "cannot remove the link at '$LINK_PATH'."
  say "  removed $LINK_PATH (was -> $target)"
elif [ -e "$LINK_PATH" ]; then
  say "  WARNING: $LINK_PATH is not a symlink, so it was left alone."
  say '  This script only removes the link it created; if that directory is a copy'
  say '  of the package, delete it yourself.'
else
  say '  no link present'
fi

say ''
say 'DONE. Refresh the page; restart dsh if this profile does not hot-reload its'
say 'patch layer.'
say 'The package directory itself was not touched.'
say "Backup: $BACKUP"
exit 0
