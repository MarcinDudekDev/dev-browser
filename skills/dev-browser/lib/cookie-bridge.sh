#!/bin/bash
# Cookie Bridge preflight + loud failure reporting.
# Sourced by the inject-session / inject-cookies fast paths.
#
# WHY THIS EXISTS
# ---------------
# Both injectors used to fail QUIETLY. inject-session would fetch nothing,
# inject nothing, print "session injected (cookies:0 ls:0 idb:0)" and exit 0 —
# so the caller kept driving a LOGGED-OUT browser and found out much later, if
# ever. Two multi-week stalls came out of exactly that shape:
#   usertask #1025 — bridge answered "No approved session" and nothing downstream
#                    said which domain or what a human should click.
#   usertask #367  — an expired Medium session stalled a publish queue 70 days.
# Same failure shape both times: an unapproved or expired session failing
# silently instead of loudly.
#
# THE RULE HERE: no usable session => non-zero exit, and a message that names
# the DOMAIN and the exact thing a HUMAN has to click. Never a truthful-but-
# irrelevant success line.

CB_AGENT_ID="${CB_AGENT_ID:-dev-browser}"
CB_TOKEN_FILE="${CB_TOKEN_FILE:-${HOME}/.cookie-bridge/token}"
CB_CLI="${CB_CLI:-${HOME}/Tools/cookie-bridge/cli.sh}"
# Warn when an approved session is this close to dying. A publish queue that
# starts a 10-minute job on a 2-minute session is #367 happening again.
CB_EXPIRY_WARN_SECONDS="${CB_EXPIRY_WARN_SECONDS:-300}"

CB_RULE="══════════════════════════════════════════════════════════════════════"

_cb_err() { printf '%s\n' "$*" >&2; }

# Read the local token into $CB_TOKEN, or die loudly.
#
# Deliberately NOT used as `CB_TOKEN=$(cb_token ...)`: cb_die ends in `exit 1`,
# and an exit inside a command substitution only kills the subshell — the caller
# would sail on with an empty token and hit a 401 it was never told about. That
# is the same silent-failure shape this whole file exists to kill, so the token
# has to be set by assignment in the caller's own shell.
cb_load_token() {
    local domain="$1" port="$2"
    if [[ ! -f "$CB_TOKEN_FILE" ]]; then
        cb_die "$domain" "$port" "COOKIE BRIDGE TOKEN MISSING" \
            "No token file at $CB_TOKEN_FILE." \
            "The proxy writes it on startup, so this almost always means the" \
            "proxy has never run on this machine (or the file was deleted)."
    fi
    CB_TOKEN="$(tr -d '[:space:]' < "$CB_TOKEN_FILE")"
    if [[ -z "$CB_TOKEN" ]]; then
        cb_die "$domain" "$port" "COOKIE BRIDGE TOKEN FILE IS EMPTY" \
            "$CB_TOKEN_FILE exists but contains nothing. Restart the proxy so it" \
            "rewrites the token: ${CB_CLI} stop && ${CB_CLI} start"
    fi
}

# cb_get <port> <path-with-query>
# Sets CB_HTTP_CODE and CB_BODY. Returns 1 when the proxy is unreachable.
cb_get() {
    local port="$1" path="$2" resp
    resp=$(curl -s -m 10 -w $'\n%{http_code}' \
        -H "X-CB-Token: ${CB_TOKEN}" "http://127.0.0.1:${port}${path}" 2>/dev/null)
    if [[ -z "$resp" ]]; then
        CB_HTTP_CODE="000"; CB_BODY=""
        return 1
    fi
    CB_HTTP_CODE="${resp##*$'\n'}"
    CB_BODY="${resp%$'\n'*}"
    [[ "$CB_HTTP_CODE" == "000" ]] && return 1
    return 0
}

# Current auth state for a domain: approved | pending | denied | expired | none
# | unreachable. Never fails — the caller decides what to do with the answer.
cb_state() {
    local domain="$1" port="$2"
    if ! cb_get "$port" "/auth/status/${domain}"; then
        printf 'unreachable\n'
        return 0
    fi
    local state
    state=$(printf '%s' "$CB_BODY" | jq -r '.state // empty' 2>/dev/null)
    printf '%s\n' "${state:-none}"
}

# Is the Brave extension currently polling? yes | no | unknown
cb_extension_connected() {
    local port="$1"
    cb_get "$port" "/health" || { printf 'unknown\n'; return 0; }
    local connected
    connected=$(printf '%s' "$CB_BODY" | jq -r '.extension_connected // empty' 2>/dev/null)
    case "$connected" in
        true)  printf 'yes\n' ;;
        false) printf 'no\n' ;;
        *)     printf 'unknown\n' ;;
    esac
}

# The heart of this file: print the loud, actionable block and exit 1.
# cb_die <domain> <port> <headline> [detail lines...]
cb_die() {
    local domain="$1" port="$2" headline="$3"; shift 3
    local state ext
    state=$(cb_state "$domain" "$port")
    ext=$(cb_extension_connected "$port")

    _cb_err ""
    _cb_err "$CB_RULE"
    _cb_err "  ✖ ${headline}"
    _cb_err "  domain: ${domain}    bridge: 127.0.0.1:${port}    auth state: ${state}"
    _cb_err "$CB_RULE"
    local line
    for line in "$@"; do _cb_err "  ${line}"; done
    _cb_err ""
    _cb_err "  NOTHING WAS INJECTED. Anything you run against ${domain} now runs"
    _cb_err "  LOGGED OUT. Do not retry in a loop — no amount of retrying creates"
    _cb_err "  a session; a human has to approve one."
    _cb_err ""
    _cb_err "  WHAT A HUMAN (Marcin) HAS TO DO — an agent cannot do this part:"

    case "$state" in
        unreachable)
            _cb_err "   1. Start the proxy:   ${CB_CLI} start"
            _cb_err "   2. Check it is up:    ${CB_CLI} status"
            _cb_err "   3. Then re-request approval for ${domain} (step below)."
            _cb_err ""
            cb_print_request_snippet "$domain" "$port"
            ;;
        pending)
            _cb_err "   ${domain} is ALREADY waiting for approval — no new request needed."
            _cb_err "   1. Open BRAVE (the request only appears there)."
            _cb_err "   2. Click the Cookie Bridge extension icon in the Brave toolbar."
            _cb_err "   3. Click \"Approve\" on the ${domain} request (it shows within 30s)."
            _cb_err "   4. Re-run this exact command."
            ;;
        denied)
            _cb_err "   ${domain} was previously DENIED in the Brave popup. Re-request it:"
            _cb_err ""
            cb_print_request_snippet "$domain" "$port"
            ;;
        expired|none|*)
            cb_print_request_snippet "$domain" "$port"
            ;;
    esac

    if [[ "$ext" == "no" ]]; then
        _cb_err ""
        _cb_err "  ⚠ The Brave extension is NOT polling right now. Approval cannot"
        _cb_err "    reach you until Brave is open with Cookie Bridge enabled —"
        _cb_err "    an /auth/request sent now is refused (503), not queued."
    fi

    _cb_err ""
    _cb_err "  Sessions are short-lived (60 min idle by default). If this is a long"
    _cb_err "  queue, re-check state before each item rather than assuming."
    _cb_err "$CB_RULE"
    _cb_err ""
    exit 1
}

cb_print_request_snippet() {
    local domain="$1" port="$2"
    _cb_err "   APPROVAL STEPS:"
    _cb_err "   1. Make sure BRAVE is open with the Cookie Bridge extension enabled."
    _cb_err "   2. Log in to https://${domain} in Brave, as yourself."
    _cb_err "   3. Request approval:"
    _cb_err "      curl -s -X POST http://127.0.0.1:${port}/auth/request -H 'Content-Type: application/json' -H \"X-CB-Token: \$(tr -d '[:space:]' < ${CB_TOKEN_FILE})\" -d '{\"domain\":\"${domain}\",\"login_url\":\"https://${domain}\",\"agent_id\":\"${CB_AGENT_ID}\"}'"
    _cb_err "   4. In BRAVE: click the Cookie Bridge extension icon, then click"
    _cb_err "      \"Approve\" for ${domain} (the prompt appears within 30 seconds)."
    _cb_err "   5. Re-run this exact command."
}

# Turn a Cookie Bridge JSON error body + HTTP code into a loud death.
# cb_die_from_response <domain> <port> <what> <http_code> <body>
cb_die_from_response() {
    local domain="$1" port="$2" what="$3" code="$4" body="$5"
    local err
    err=$(printf '%s' "$body" | jq -r '.error // .detail // empty' 2>/dev/null)
    case "$code" in
        000)
            cb_die "$domain" "$port" "COOKIE BRIDGE IS NOT ANSWERING" \
                "Nothing is listening on 127.0.0.1:${port} (fetching ${what})." ;;
        401|403)
            cb_die "$domain" "$port" "COOKIE BRIDGE REFUSED: NO APPROVED SESSION" \
                "Fetching ${what} returned HTTP ${code}: ${err:-no approved session}." ;;
        410)
            cb_die "$domain" "$port" "COOKIE BRIDGE SESSION HAS EXPIRED" \
                "Fetching ${what} returned HTTP 410: ${err:-session expired}." \
                "The approval existed but has aged out; the ciphertext is wiped." ;;
        *)
            cb_die "$domain" "$port" "COOKIE BRIDGE ERROR WHILE FETCHING ${what}" \
                "HTTP ${code}: ${err:-unrecognised response}" ;;
    esac
}

# Loudly warn when an approved session is about to die mid-run.
cb_warn_if_expiring() {
    local domain="$1" port="$2"
    cb_get "$port" "/auth/status/${domain}" || return 0
    local remaining
    remaining=$(printf '%s' "$CB_BODY" | jq -r '.expires_in_seconds // empty' 2>/dev/null)
    [[ -z "$remaining" || "$remaining" == "null" ]] && return 0
    if (( remaining <= CB_EXPIRY_WARN_SECONDS )); then
        _cb_err ""
        _cb_err "⚠ COOKIE BRIDGE SESSION FOR ${domain} EXPIRES IN ${remaining}s."
        _cb_err "  Anything longer than that WILL start failing mid-run, and the"
        _cb_err "  failure looks like 'logged out', not like an error. Re-approve in"
        _cb_err "  the Brave Cookie Bridge popup before starting a long job."
        _cb_err ""
    fi
}

# Cookies can be present and already dead. If every cookie carrying an expiry
# is in the past, the injection is worthless — say so instead of reporting a
# cheerful count.
# cb_assert_cookies_alive <domain> <port> <cookies-json>
cb_assert_cookies_alive() {
    local domain="$1" port="$2" cookies_json="$3"
    local now dated expired
    now=$(date +%s)
    dated=$(printf '%s' "$cookies_json" | jq --argjson now "$now" \
        '[.[] | select((.expires // -1) > 0)] | length' 2>/dev/null)
    expired=$(printf '%s' "$cookies_json" | jq --argjson now "$now" \
        '[.[] | select((.expires // -1) > 0 and .expires < $now)] | length' 2>/dev/null)
    [[ -z "$dated" || "$dated" == "0" ]] && return 0   # all session cookies — cannot judge
    if [[ "$expired" == "$dated" ]]; then
        cb_die "$domain" "$port" "EVERY DATED COOKIE FOR ${domain} IS ALREADY EXPIRED" \
            "The bridge returned ${dated} cookies with an expiry and all ${expired} of" \
            "them are in the past. Injecting them would produce a logged-out page" \
            "that LOOKS authenticated. The browser session behind the bridge needs" \
            "a fresh login."
    fi
}

# The single most important guard: refuse to report success on an empty inject.
# cb_assert_payload <domain> <port> <cookies> <ls_keys> <idb_dbs>
cb_assert_payload() {
    local domain="$1" port="$2" cookies="${3:-0}" ls="${4:-0}" idb="${5:-0}"
    if [[ "$cookies" == "0" && "$ls" == "0" && "$idb" == "0" ]]; then
        cb_die "$domain" "$port" "COOKIE BRIDGE RETURNED AN EMPTY SESSION FOR ${domain}" \
            "0 cookies, 0 localStorage keys, 0 IndexedDB databases." \
            "The bridge answered without an error but has nothing stored for this" \
            "domain — usually the approval was granted before you logged in to" \
            "${domain} in Brave, so there was no session to capture."
    fi
}
