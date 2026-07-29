#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)
CLI="$ROOT/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
NODE_BIN=${NODE_BIN:-node}

fail() {
  printf 'FAIL Pi contract: %s\n' "$1" >&2
  exit 1
}

[ -f "$CLI" ] || fail 'the pinned CLI is not installed'

version=$("$NODE_BIN" "$CLI" --version 2>/dev/null) || fail 'the pinned CLI did not start'
[ "$version" = '0.82.1' ] || fail "expected Pi 0.82.1, got $version"

node_version=$("$NODE_BIN" -p 'process.versions.node') || fail 'Node did not start'
"$NODE_BIN" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || fail "Node $node_version does not satisfy >=22.19.0"

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$tmp/home" "$tmp/workspace" "$tmp/agent"

help=$(
  cd "$tmp/workspace"
  HOME="$tmp/home" PI_CODING_AGENT_DIR="$tmp/agent" PI_OFFLINE=1 \
    "$NODE_BIN" "$CLI" --help 2>&1
) || fail 'the pinned CLI help command failed'

for option in '--continue' '--session-dir' '--tools' '--system-prompt'; do
  case "$help" in
    *"$option"*) ;;
    *) fail "the pinned CLI does not expose $option" ;;
  esac
done

grep -q -- '--tools read,bash,grep,find,ls' "$ROOT/bin/marvin" ||
  fail 'the launcher tool policy changed unexpectedly'
grep -q -- '--continue' "$ROOT/bin/marvin" || fail 'the launcher no longer continues sessions'
grep -q 'You are Marvin' "$ROOT/config/system-prompt.md" || fail 'the Marvin prompt is missing'

descriptor_file="$tmp/descriptor"
: > "$descriptor_file"
sh -c 'exec 9<"$1"; exec "$2" -e '\''require("node:fs").fstatSync(9)'\''' sh \
  "$descriptor_file" "$NODE_BIN" || fail 'Node did not inherit descriptor 9 through exec'

child_result=$(sh -c 'exec 9<"$1"; exec "$2" -e '\''
  const { spawnSync } = require("node:child_process");
  const result = spawnSync("sh", ["-c", "if true <&9 2>/dev/null; then printf open; else printf closed; fi"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(result.stdout);
'\''' sh "$descriptor_file" "$NODE_BIN") || fail 'the descriptor child check failed'
[ "$child_result" = 'closed' ] || fail 'normal Node children retain descriptor 9'

printf 'PASS Pi %s contract\n' "$version"
