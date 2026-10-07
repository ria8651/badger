#!/bin/bash
# CLAUDE_CODE_SHELL_PREFIX wrapper. Claude Code passes its whole Bash command
# string as $1; we run it unchanged and copy its output to a log the server
# tails (see server/bashStream.ts). Exit status and stdout/stderr are preserved.

shell=bash
case "$1" in *snapshot-zsh-*) shell=zsh ;; esac

if [ -z "$BADGER_STREAM_DIR" ] || [ -z "$CLAUDE_CODE_SESSION_ID" ]; then exec "$shell" -c "$1"; fi

log="$BADGER_STREAM_DIR/$CLAUDE_CODE_SESSION_ID.$$"
: > "$log.out"
printf '%s' "$1" > "$log.tmp" && mv "$log.tmp" "$log.cmd"
"$shell" -c "$1" > >(tee -a "$log.out") 2> >(tee -a "$log.out" >&2)
