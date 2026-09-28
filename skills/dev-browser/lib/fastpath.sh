#!/bin/bash
# Shared POST helper for the builtins/*.sh fast path.
#
# Usage:  result=$(fp_post <endpoint-path> <json-body> <max-seconds>) || exit 1
#
# WHY THIS EXISTS
# ---------------
# Every fast-path script used to do `result=$(curl -s -m 10 ...)` and then only
# look for `.error` in the body. When curl gave up first (timeout, refused
# connection) the body was EMPTY, `.error` was therefore empty too, and the
# script printed its success line: `Clicked : Anuluj` with a blank URL and
# Title, exit 0. The server was still working through its fallback chain and
# either clicked later - after the caller had already moved on - or never did.
# Every UI verification built on it reported success it had not observed
# (asrowerowy-system #181, 2026-09-28).
#
# The rule: no parseable JSON reply means FAILURE, never success. A reply we
# could not read is not evidence that anything happened.
fp_post() {
    local path="$1" body="$2" max="${3:-30}"
    local out rc
    out=$(curl -s -S -m "$max" -X POST "http://localhost:${SERVER_PORT}${path}" \
        -H 'Content-Type: application/json' -d "$body" 2>&1)
    rc=$?
    if [[ $rc -ne 0 ]]; then
        if [[ $rc -eq 28 ]]; then
            echo "dev-browser: no reply from server within ${max}s for ${path} - the action may still be running; its outcome is UNKNOWN, not successful" >&2
        else
            echo "dev-browser: request to ${path} failed (curl exit ${rc}): ${out}" >&2
        fi
        return 1
    fi
    if [[ -z "$out" ]] || ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$out"; then
        echo "dev-browser: unreadable reply from ${path}: ${out:0:200}" >&2
        return 1
    fi
    printf '%s' "$out"
}
