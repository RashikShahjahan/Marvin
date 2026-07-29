#!/bin/sh

set -u

ROOT=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)

skip() {
  printf 'SKIP launcher integration: %s\n' "$1"
  exit 0
}

fail() {
  printf 'FAIL launcher integration: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Linux" ] || skip 'requires the Linux deployment target'
command -v flock >/dev/null 2>&1 || skip 'util-linux flock is unavailable'
flock --version 2>/dev/null | grep -q 'util-linux' || skip 'util-linux flock is unavailable'
command -v script >/dev/null 2>&1 || skip 'script(1) is unavailable'
[ "$(id -u)" -ne 0 ] || skip 'requires a non-root test account'

tmp=$(mktemp -d)
cleanup() {
  chmod -R u+w "$tmp" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM

release="$tmp/release"
admin="$tmp/admin"
home="$tmp/home"
workspace="$tmp/workspace"
session_dir="$tmp/sessions"
config_file="$admin/marvin.conf"
lock_file="$admin/instance.lock"
fake_node="$tmp/fake-node"
flock_bin=$(command -v flock)
uid=$(id -u)

mkdir -p "$release/bin" "$release/config" \
  "$release/node_modules/@earendil-works/pi-coding-agent/dist" \
  "$admin" "$home" "$workspace" "$session_dir"
chmod 700 "$home" "$session_dir"
chmod 755 "$admin"

cp "$ROOT/config/system-prompt.md" "$release/config/system-prompt.md"
: > "$release/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
: > "$lock_file"
chmod 444 "$lock_file"

cat > "$fake_node" <<'EOF'
#!/bin/sh
{
  printf 'cwd=%s\n' "$PWD"
  if true <&9 2>/dev/null; then
    printf 'fd9=open\n'
  else
    printf 'fd9=closed\n'
  fi
  for argument in "$@"; do
    printf 'arg=%s\n' "$argument"
  done
} > "$TEST_OUTPUT"

if [ -n "${TEST_HOLD_FILE:-}" ]; then
  : > "$TEST_READY_FILE"
  while [ -e "$TEST_HOLD_FILE" ]; do
    sleep 0.05
  done
fi

exit "${TEST_EXIT_CODE:-0}"
EOF
chmod 755 "$fake_node"

cat > "$config_file" <<EOF
MARVIN_WORKSPACE="$workspace"
MARVIN_SESSION_DIR="$session_dir"
MARVIN_NODE_BIN="$fake_node"
EOF
chmod 444 "$config_file"

sed \
  -e "s|^CONFIG_FILE=.*|CONFIG_FILE=\"$config_file\"|" \
  -e "s|^LOCK_FILE=.*|LOCK_FILE=\"$lock_file\"|" \
  -e "s|^FLOCK_BIN=.*|FLOCK_BIN=\"$flock_bin\"|" \
  -e "s|^ADMIN_UID=.*|ADMIN_UID=\"$uid\"|" \
  "$ROOT/bin/marvin" > "$release/bin/marvin"
chmod 755 "$release/bin/marvin"
launcher="$release/bin/marvin"

run_pty() {
  script -qefc "$1" /dev/null
}

output="$tmp/output"
terminal_output="$tmp/terminal-output"

if HOME="$home" TEST_OUTPUT="$output" "$launcher" >"$terminal_output" 2>&1; then
  fail 'a launch without a PTY succeeded'
fi
grep -q 'Marvin requires an interactive SSH terminal.' "$terminal_output" ||
  fail 'the missing-PTY error was not actionable'

if run_pty "HOME=$home SSH_ORIGINAL_COMMAND=whoami TEST_OUTPUT=$output $launcher" >"$terminal_output" 2>&1; then
  fail 'a remote command succeeded'
fi
grep -q 'Marvin does not accept remote commands.' "$terminal_output" ||
  fail 'the remote-command error was not actionable'

run_pty "HOME=$home TEST_OUTPUT=$output $launcher" >"$terminal_output" 2>&1 ||
  fail 'a valid launch failed'
grep -q "cwd=$workspace" "$output" || fail 'Pi received the wrong working directory'
grep -q 'fd9=open' "$output" || fail 'Pi did not inherit the lock descriptor'
grep -q 'arg=--continue' "$output" || fail 'the continue flag was omitted'
grep -q "arg=--session-dir" "$output" || fail 'the session-dir flag was omitted'
grep -q "arg=$session_dir" "$output" || fail 'Pi received the wrong session directory'
grep -q 'arg=--tools' "$output" || fail 'the tools flag was omitted'
grep -q 'arg=read,bash,grep,find,ls' "$output" || fail 'Pi received the wrong tool allowlist'
grep -q 'arg=--system-prompt' "$output" || fail 'the system-prompt flag was omitted'

chmod 755 "$session_dir"
if run_pty "HOME=$home TEST_OUTPUT=$output $launcher" >"$terminal_output" 2>&1; then
  fail 'an insecure session directory was accepted'
fi
grep -q 'must not grant group or other permissions' "$terminal_output" ||
  fail 'the insecure-session error was not actionable'
chmod 700 "$session_dir"

hold="$tmp/hold"
ready="$tmp/ready"
: > "$hold"
run_pty "HOME=$home TEST_OUTPUT=$output TEST_HOLD_FILE=$hold TEST_READY_FILE=$ready $launcher" \
  >"$terminal_output" 2>&1 &
first_pid=$!

attempt=0
while [ ! -e "$ready" ] && [ "$attempt" -lt 100 ]; do
  sleep 0.05
  attempt=$((attempt + 1))
done
[ -e "$ready" ] || fail 'the first launch did not become ready'

busy_output="$tmp/busy-output"
if run_pty "HOME=$home TEST_OUTPUT=$tmp/second-output $launcher" >"$busy_output" 2>&1; then
  fail 'a competing launch succeeded'
else
  busy_status=$?
fi
[ "$busy_status" -eq 75 ] || fail 'lock contention did not use exit code 75'
grep -q 'Marvin is already active.' "$busy_output" || fail 'the busy error was not actionable'

rm "$hold"
wait "$first_pid" || fail 'the first launch failed after releasing its hold'
run_pty "HOME=$home TEST_OUTPUT=$output $launcher" >"$terminal_output" 2>&1 ||
  fail 'the lock was not released when Pi exited'

if run_pty "HOME=$home TEST_OUTPUT=$output TEST_EXIT_CODE=42 $launcher" >"$terminal_output" 2>&1; then
  fail 'Pi exit status 42 was lost'
else
  exit_status=$?
fi
[ "$exit_status" -eq 42 ] || fail 'Pi exit status was not preserved by exec'

rm "$lock_file"
ln -s "$config_file" "$lock_file"
if run_pty "HOME=$home TEST_OUTPUT=$output $launcher" >"$terminal_output" 2>&1; then
  fail 'a symbolic-link lock inode was accepted'
fi
grep -q 'instance lock is missing or insecure' "$terminal_output" ||
  fail 'the invalid-lock error was not actionable'

printf 'PASS launcher integration\n'
