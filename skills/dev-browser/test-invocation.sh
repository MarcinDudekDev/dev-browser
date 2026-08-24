#!/bin/bash
# Regression: dev-browser.sh must work through EVERY path it is reachable by.
#
# Why this exists. The script resolved its own location with a single
# `readlink`, which was correct for exactly as long as there was one symlink in
# front of it. A second symlink (in the skill directory) made the chain two hops
# and one readlink stopped in the middle, so LIB_DIR pointed at a directory that
# does not exist and the sourced helpers were never loaded.
#
# The reason it shipped is the part worth encoding: `--help` still printed. Help
# runs before any sourced function is needed, so the script LOOKED healthy while
# mode handling and the audit log were dead, and every other command would have
# failed. Seeing help is not evidence that the script works.
#
# So this asserts two things per path, not one:
#   1. no shell errors on stderr  (unbound vars, missing files, missing funcs)
#   2. a command that actually USES the sourced helpers succeeds
set -uo pipefail

# Resolve the real script from this file's own location rather than hardcoding a
# home directory — the checkout lives somewhere different on every machine.
REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-browser.sh"
PATHS=(
    "$REAL"                                              # direct, no symlink
    "$HOME/Tools/dev-browser.sh"                         # one hop, on PATH
    "$HOME/.claude/skills/dev-browser/dev-browser.sh"    # two hops, skill dir
)

pass=0; fail=0
err=$(mktemp "${TMPDIR:-/tmp}/dbtest.XXXXXX")
trap 'rm -f "$err"' EXIT

for p in "${PATHS[@]}"; do
    if [[ ! -e "$p" ]]; then
        printf '  SKIP  %s (not present)\n' "$p"
        continue
    fi

    # 1. no shell-level breakage
    "$p" --help >/dev/null 2>"$err"
    n=$(grep -cE 'No such file or directory|command not found|unbound variable|Bad substitution' "$err")
    if [[ "$n" -eq 0 ]]; then
        printf '  ok    no shell errors via %s\n' "$p"; pass=$((pass+1))
    else
        printf '  FAIL  %s emitted %s shell error(s):\n' "$p" "$n"; fail=$((fail+1))
        sed -n '1,4p' "$err" | sed 's/^/          /'
    fi

    # 2. a real command, because --help proves nothing about the sourced half
    if "$p" --list >/dev/null 2>"$err"; then
        m=$(grep -cE 'No such file or directory|command not found' "$err")
        if [[ "$m" -eq 0 ]]; then
            printf '  ok    --list works via %s\n' "$p"; pass=$((pass+1))
        else
            printf '  FAIL  --list via %s hit missing helpers\n' "$p"; fail=$((fail+1))
        fi
    else
        printf '  FAIL  --list via %s exited nonzero\n' "$p"; fail=$((fail+1))
    fi
done

echo
echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
