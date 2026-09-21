#!/bin/bash
# Regression: `--tabs` must print each URL in full, never a prefix of one.
#
# Why this exists. The listing used to cut every URL at 70 characters, with no
# ellipsis and no other mark, so a truncated URL was indistinguishable from a
# short one. That is fine for a human reading the output and wrong for
# everything else, because the comment directly above that code already said
# the listing gets read programmatically to answer "did a tab open".
#
# What it cost, measured 2026-09-21 on ~/Tools/jev-browser: after any click
# that navigated the same tab, the new URL was absent from the previous tab
# list, so it looked like a newly opened tab. The guard meant to catch exactly
# that compares the candidate against the URL already on screen - and it could
# never match, because the candidate had been cut at 70 characters and the
# other side had not. So on 5 runs out of 5, jev opened a SECOND browser page
# and navigated it to the truncated address: a different page from the one it
# meant to look at, whose content it then fed to the model as "the tab that
# opened". On this fixture the tail was `=12&projector=yes`; on a real site it
# is a session id, a cart id or a page number.
#
# The assertion is deliberately about a URL LONGER than the old limit. A test
# using a short URL passes against the broken code and proves nothing.
set -uo pipefail

DB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-browser.sh"
PAGE="tabsurltest$$"

root=$(mktemp -d "${TMPDIR:-/tmp}/dbtabs.XXXXXX")
printf '<!doctype html><title>Tabs URL test</title><h1>ok</h1>' > "$root/index.html"

# `python3 -m http.server 0` prints its port to a BLOCK-BUFFERED stdout when
# that is a file, so the line never arrives and the port is unreadable. Bind
# here instead and flush it deliberately.
python3 -c '
import http.server, socketserver, os, sys
os.chdir(sys.argv[1])
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", 0),
                             http.server.SimpleHTTPRequestHandler)
print(srv.server_address[1], flush=True)
srv.serve_forever()
' "$root" > "$root/srv.log" 2>&1 &
srv=$!
cleanup() {
    "$DB" --dev -p "$PAGE" --cleanup --only "$PAGE" > /dev/null 2>&1
    kill "$srv" 2>/dev/null
    rm -rf "$root"
}
trap cleanup EXIT

# The port is chosen by the kernel; read it back rather than guessing one that
# might already be taken on the machine running this.
port=""
for _ in $(seq 1 50); do
    port=$(grep -m1 -o '^[0-9]\{2,5\}$' "$root/srv.log" 2>/dev/null)
    [[ -n "$port" ]] && break
    sleep 0.1
done
if [[ -z "$port" ]]; then
    echo "FAIL: fixture server never reported a port"
    exit 1
fi

# 70 was the old cut. Everything after it is what used to vanish silently.
tail="cartid=8f3a91c7&step=review&coupon=SPRING&ref=newsletter&page=2"
url="http://127.0.0.1:$port/index.html?$tail"
if (( ${#url} <= 70 )); then
    echo "FAIL: test URL is ${#url} chars, too short to detect a 70-char cut"
    exit 1
fi

"$DB" --dev -p "$PAGE" goto "$url" > /dev/null 2>&1

tabs=$("$DB" --dev -p "$PAGE" --tabs 2>&1)

if grep -Fq "$url" <<< "$tabs"; then
    echo "PASS: --tabs printed the ${#url}-char URL in full"
    exit 0
fi

echo "FAIL: --tabs did not print the URL in full"
echo "  wanted: $url"
echo "  got the Pages section:"
sed -n '/^Pages (/,/^$/p' <<< "$tabs" | sed 's/^/    /'
exit 1
