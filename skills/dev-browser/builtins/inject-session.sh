#!/bin/bash
# Inject full session (cookies + localStorage + IndexedDB) from Cookie Bridge
# Usage: dev-browser.sh inject-session <domain> [cookie-bridge-port]
# Handles Firebase Auth, Supabase, Auth0, and other modern auth systems
# that store tokens in localStorage/IndexedDB instead of cookies.
#
# Strategy: inject into the EXISTING page context (no navigation).
# IndexedDB records are written into DBs that the page's JS already created,
# avoiding version conflicts and Cloudflare challenges on navigation.

domain="${SCRIPT_ARG0}"
cb_port="${SCRIPT_ARG1:-9999}"
PORT="${SERVER_PORT}"
PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"

if [[ -z "$domain" ]]; then
    echo "Usage: dev-browser.sh inject-session <domain> [cookie-bridge-port]" >&2
    echo "  Injects cookies + localStorage + IndexedDB from Cookie Bridge." >&2
    echo "  Example: dev-browser.sh inject-session www.indiehackers.com" >&2
    exit 1
fi

CB="http://127.0.0.1:${cb_port}"
DB="http://localhost:${PORT}"

_eval() {
    curl -s -m 30 -X POST "${DB}/pages/${PAGE_ID}/evaluate" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg code "$1" '{code: $code}')"
}

# --- 0. Verify page is on the right origin ---
current_url=$(_eval "location.href" | jq -r '.result // empty')
if [[ -z "$current_url" || "$current_url" == "about:blank" ]]; then
    echo "ERROR: Navigate to https://${domain} first" >&2
    exit 1
fi

# --- 1. Fetch all session data from Cookie Bridge (token-gated) ---
CB_TOKEN_FILE="${HOME}/.cookie-bridge/token"
if [[ ! -f "$CB_TOKEN_FILE" ]]; then
    echo "Cookie Bridge token missing at $CB_TOKEN_FILE — is the proxy running?" >&2
    exit 1
fi
CB_TOKEN="$(tr -d '[:space:]' < "$CB_TOKEN_FILE")"
cb_result=$(curl -s -m 10 -H "X-CB-Token: ${CB_TOKEN}" \
    "${CB}/cookies?domain=${domain}&agent_id=dev-browser")
cb_error=$(echo "$cb_result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$cb_error" ]]; then
    echo "Cookie Bridge error: $cb_error" >&2
    exit 1
fi

cookie_count=$(echo "$cb_result" | jq -r '.count // 0' 2>/dev/null)
cookies_json=$(echo "$cb_result" | jq -c '.cookies' 2>/dev/null)

storage_result=$(curl -s -m 10 -H "X-CB-Token: ${CB_TOKEN}" \
    "${CB}/storage?domain=${domain}&agent_id=dev-browser")
storage_error=$(echo "$storage_result" | jq -r '.error // empty' 2>/dev/null)

ls_count=0
idb_count=0
if [[ -z "$storage_error" ]]; then
    ls_count=$(echo "$storage_result" | jq -r '.localStorage_keys // 0' 2>/dev/null)
    idb_count=$(echo "$storage_result" | jq -r '.indexedDB_databases // 0' 2>/dev/null)
fi

# --- 2. Inject cookies (Playwright context + document.cookie fallback) ---
if [[ "$cookie_count" != "0" ]]; then
    curl -s -m 10 -X POST "${DB}/cookies" \
        -H "Content-Type: application/json" \
        -d "{\"cookies\":${cookies_json}}" > /dev/null 2>&1

    cookie_set_js=$(echo "$cb_result" | jq -r '.cookies[] | "document.cookie = \"" + .name + "=" + .value + "; path=" + .path + "; domain=." + (.domain | ltrimstr(".") | ltrimstr("www.")) + "\";"' 2>/dev/null | sort -u | tr '\n' ' ')
    if [[ -n "$cookie_set_js" ]]; then
        _eval "${cookie_set_js} 'ok'" > /dev/null
    fi
    echo "Injected ${cookie_count} cookies"
fi

# --- 3. Inject localStorage ---
if [[ "$ls_count" != "0" ]]; then
    ls_json=$(echo "$storage_result" | jq -c '.localStorage' 2>/dev/null)
    ls_code="const ls = ${ls_json}; for (const [k, v] of Object.entries(ls)) { localStorage.setItem(k, v); }; 'ok'"
    _eval "$ls_code" > /dev/null
    echo "Injected ${ls_count} localStorage keys"
fi

# --- 4. Inject IndexedDB (in-place, no navigation) ---
# Strategy: for each DB, set data on window, then open existing DB and write records.
# If the DB doesn't exist yet, create it with version 1.
# This avoids deleteDatabase (blocks on open connections) and navigation (Cloudflare).
if [[ "$idb_count" != "0" ]]; then
    idb_json=$(echo "$storage_result" | jq -c '.indexedDB' 2>/dev/null)

    # Set the full IDB data on window (reliable data transfer to page context)
    _eval "window.__cb_idb = ${idb_json}; 'ok'" > /dev/null

    # Process each DB: open (create if needed), clear stores, write records
    idb_code='(async () => {
const idbData = window.__cb_idb;
if (!idbData) return "no_data";
const results = [];
for (const [dbName, dbData] of Object.entries(idbData)) {
  const hasStoresMeta = dbData._meta && dbData.stores;
  const storesObj = hasStoresMeta ? dbData.stores : dbData;
  const storeEntries = Object.entries(storesObj);
  // Try opening without version first (uses existing DB if present)
  let db;
  try {
    db = await new Promise((res, rej) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    // Check if all stores exist
    const missing = storeEntries.filter(([sn]) => !db.objectStoreNames.contains(sn));
    if (missing.length > 0) {
      // Need to upgrade to add missing stores
      const newVer = db.version + 1;
      db.close();
      db = await new Promise((res, rej) => {
        const req = indexedDB.open(dbName, newVer);
        req.onupgradeneeded = (e) => {
          const udb = e.target.result;
          for (const [sn, sd] of missing) {
            let meta = sd && sd.meta ? sd.meta : {};
            if (!meta.keyPath) {
              const recs = Array.isArray(sd) ? sd : (sd.records || []);
              if (recs.length > 0 && recs[0].value && recs[0].value.fbase_key) meta = {keyPath: "fbase_key"};
            }
            const opts = {};
            if (meta.keyPath != null) opts.keyPath = meta.keyPath;
            if (meta.autoIncrement) opts.autoIncrement = true;
            udb.createObjectStore(sn, opts);
          }
        };
        req.onblocked = () => rej("blocked");
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    }
  } catch(e) {
    // DB does not exist yet — create with version 1
    db = await new Promise((res, rej) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = (e) => {
        const udb = e.target.result;
        for (const [sn, sd] of storeEntries) {
          let meta = sd && sd.meta ? sd.meta : {};
          if (!meta.keyPath) {
            const recs = Array.isArray(sd) ? sd : (sd.records || []);
            if (recs.length > 0 && recs[0].value && recs[0].value.fbase_key) meta = {keyPath: "fbase_key"};
          }
          const opts = {};
          if (meta.keyPath != null) opts.keyPath = meta.keyPath;
          if (meta.autoIncrement) opts.autoIncrement = true;
          udb.createObjectStore(sn, opts);
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  // Write records to each store
  for (const [storeName, storeData] of storeEntries) {
    const records = Array.isArray(storeData) ? storeData : (storeData.records || []);
    let meta = (!Array.isArray(storeData) && storeData.meta) ? storeData.meta : {};
    if (!meta.keyPath && records.length > 0 && records[0].value && records[0].value.fbase_key) {
      meta = {keyPath: "fbase_key"};
    }
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.clear();
    for (const record of records) {
      if (meta.keyPath) store.put(record.value);
      else store.put(record.value, record.key);
    }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej("tx_err"); });
  }
  db.close();
  results.push(dbName);
}
delete window.__cb_idb;
return "injected:" + results.join(",");
})()'

    result=$(_eval "$idb_code" | jq -r '.result // .error // "unknown"')
    echo "Injected ${idb_count} IndexedDB databases (${result})"
fi

# --- 5. Reload ---
_eval "location.reload()" > /dev/null
echo "Page reloaded — session injected (cookies:${cookie_count} ls:${ls_count} idb:${idb_count})"
