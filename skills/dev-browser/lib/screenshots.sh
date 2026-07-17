#!/bin/bash
# Screenshot commands

cmd_screenshot() {
    # Usage: cmd_screenshot [page] [filename] [--scroll-to <sel|px>] [--selector <css>]
    local page_name="" filename="" scroll_to="" selector=""
    local _pos_args=()

    # Parse args passed directly to cmd_screenshot
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --scroll-to) scroll_to="$2"; shift 2 ;;
            --selector)  selector="$2"; shift 2 ;;
            --*) shift ;;
            *) _pos_args+=("$1"); shift ;;
        esac
    done

    # Positional: [page] [filename]
    [[ ${#_pos_args[@]} -ge 1 ]] && page_name="${_pos_args[0]}"
    [[ ${#_pos_args[@]} -ge 2 ]] && filename="${_pos_args[1]}"

    # Fall back to PAGE_NAME env (from -p flag)
    page_name="${page_name:-${PAGE_NAME:-main}}"

    # Also read from env (set by dispatch in dev-browser.sh)
    [[ -z "$scroll_to" && -n "${SCROLL_TO:-}" ]] && scroll_to="$SCROLL_TO"
    [[ -z "$selector" && -n "${SELECTOR_TARGET:-}" ]] && selector="$SELECTOR_TARGET"

    get_project_paths
    filename=$(basename "${filename:-screenshot-$(date +%s).png}")
    local screenshot_path="$PROJECT_SCREENSHOTS_DIR/$filename"
    start_server || return 1
    local PREFIX=$(get_project_prefix)
    mkdir -p "$PROJECT_SCREENSHOTS_DIR"

    # Resolve page name (accepts name, prefixed name, or URL)
    local pages_json
    pages_json=$(curl -s -m 10 "http://localhost:${SERVER_PORT}/pages")
    local target_name
    target_name=$(resolve_page_name "$page_name" "$pages_json" "$PREFIX") || return 1

    local encoded_name
    encoded_name=$(printf '%s' "$target_name" | jq -sRr '@uri')

    # If --scroll-to specified, scroll first via evaluate endpoint
    if [[ -n "$scroll_to" ]]; then
        local scroll_js
        if [[ "$scroll_to" =~ ^[0-9]+$ ]]; then
            scroll_js="window.scrollTo(0, ${scroll_to})"
        else
            scroll_js="(() => { const el = document.querySelector($(printf '%s' "$scroll_to" | jq -Rs '.')); if (el) el.scrollIntoView({behavior:'instant',block:'start'}); })()"
        fi
        local scroll_body
        scroll_body=$(jq -nc --arg code "$scroll_js" '{code: $code}')
        curl -s -m 10 -X POST "http://localhost:${SERVER_PORT}/pages/${encoded_name}/evaluate" \
            -H "Content-Type: application/json" -d "$scroll_body" >/dev/null
    fi

    # Build screenshot request body
    local body
    if [[ -n "$selector" ]]; then
        body=$(jq -nc --arg path "$screenshot_path" --arg sel "$selector" '{path: $path, selector: $sel}')
    elif [[ -n "$scroll_to" ]]; then
        # After scroll-to, take viewport screenshot (not fullPage)
        body=$(jq -nc --arg path "$screenshot_path" '{path: $path, fullPage: false}')
    else
        body=$(jq -nc --arg path "$screenshot_path" '{path: $path, fullPage: true}')
    fi

    local result
    result=$(curl -s -m 35 -X POST "http://localhost:${SERVER_PORT}/pages/${encoded_name}/screenshot" \
        -H "Content-Type: application/json" -d "$body")

    local error
    error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
    if [[ -n "$error" ]]; then
        echo "screenshot failed: $error" >&2
        return 1
    fi

    local url viewport
    url=$(echo "$result" | jq -r '.url // empty' 2>/dev/null)
    viewport=$(echo "$result" | jq -r '.viewport // empty' 2>/dev/null)
    echo "Page URL: ${url} | Alias: ${target_name} | Viewport: ${viewport}"
    echo "Screenshot saved: ${screenshot_path}"
    resize_screenshot "$screenshot_path"
}

cmd_responsive() {
    local page_name="${1:-main}"
    get_project_paths
    local output_dir="${2:-$PROJECT_SCREENSHOTS_DIR}"
    start_server || return 1
    local PREFIX=$(get_project_prefix)
    mkdir -p "$output_dir"
    local timestamp=$(date +%Y%m%d-%H%M%S)

    # Resolve page name (accepts name, prefixed name, or URL)
    local pages_json
    pages_json=$(curl -s -m 10 "http://localhost:${SERVER_PORT}/pages")
    local target_name
    target_name=$(resolve_page_name "$page_name" "$pages_json" "$PREFIX") || return 1
    local encoded_name
    encoded_name=$(printf '%s' "$target_name" | jq -sRr '@uri')

    # Get current URL for display
    local page_url
    page_url=$(curl -s -m 5 "http://localhost:${SERVER_PORT}/pages/${encoded_name}/url" | jq -r '.url // empty' 2>/dev/null)
    echo "Taking responsive screenshots of: ${page_url}"

    local bp_name bp_w bp_h
    for bp_spec in "mobile:375:812" "tablet:768:1024" "laptop:1024:768" "desktop:1280:800"; do
        bp_name="${bp_spec%%:*}"
        bp_w="${bp_spec#*:}"; bp_w="${bp_w%%:*}"
        bp_h="${bp_spec##*:}"

        # Resize viewport
        curl -s -m 10 -X POST "http://localhost:${SERVER_PORT}/pages/${encoded_name}/resize" \
            -H "Content-Type: application/json" -d "{\"width\":${bp_w},\"height\":${bp_h}}" >/dev/null

        # Check for horizontal overflow
        local overflow_body
        overflow_body=$(jq -nc '{code: "document.documentElement.scrollWidth > document.documentElement.clientWidth"}')
        local overflow_result
        overflow_result=$(curl -s -m 10 -X POST "http://localhost:${SERVER_PORT}/pages/${encoded_name}/evaluate" \
            -H "Content-Type: application/json" -d "$overflow_body")
        local has_overflow
        has_overflow=$(echo "$overflow_result" | jq -r '.result' 2>/dev/null)
        local status_label="OK"
        [[ "$has_overflow" == "true" ]] && status_label="OVERFLOW"

        # Take screenshot
        local shot_path="${output_dir}/${timestamp}-${page_name}-${bp_name}.png"
        local shot_body
        shot_body=$(jq -nc --arg path "$shot_path" '{path: $path, fullPage: true}')
        curl -s -m 35 -X POST "http://localhost:${SERVER_PORT}/pages/${encoded_name}/screenshot" \
            -H "Content-Type: application/json" -d "$shot_body" >/dev/null

        printf "%-8s (%spx): %s -> %s\n" "$bp_name" "$bp_w" "$status_label" "$shot_path"
        resize_screenshot "$shot_path" 2>/dev/null
    done

    # Reset to desktop
    curl -s -m 10 -X POST "http://localhost:${SERVER_PORT}/pages/${encoded_name}/resize" \
        -H "Content-Type: application/json" -d '{"width":1280,"height":800}' >/dev/null
    echo ""
    echo "Viewport reset to desktop (1280x800)"
}

cmd_resize() {
    local width="$1"
    local height="${2:-900}"
    local page_name="${3:-main}"

    if [[ -z "$width" ]]; then
        echo "Usage: dev-browser.sh --resize <width|WIDTHxHEIGHT> [height] [page]" >&2
        echo "  Common widths: 375 (mobile), 768 (tablet), 1024 (laptop), 1280 (desktop)" >&2
        echo "  Examples: --resize 1440x900  or  --resize 1440 900" >&2
        return 1
    fi

    # Parse WIDTHxHEIGHT format (e.g. 1440x900)
    if [[ "$width" =~ ^([0-9]+)x([0-9]+)$ ]]; then
        height="${BASH_REMATCH[2]}"
        width="${BASH_REMATCH[1]}"
        page_name="${2:-main}"
    fi

    # Check if height is actually a page name
    if [[ ! "$height" =~ ^[0-9]+$ ]]; then
        page_name="$height"
        height=900
    fi

    start_server || return 1
    local PREFIX=$(get_project_prefix)

    # Use server-side resize endpoint so the server's Page object stays in sync
    # (client-side setViewportSize via CDP doesn't update the server's cached state)
    local full_name="${PREFIX}-${page_name}"
    local target_name="$full_name"

    # Resolve page name
    local pages_json
    pages_json=$(curl -s -m 10 "http://localhost:${SERVER_PORT}/pages")
    if ! echo "$pages_json" | jq -e --arg n "$full_name" '.pages | index($n)' >/dev/null 2>&1; then
        if echo "$pages_json" | jq -e --arg n "$page_name" '.pages | index($n)' >/dev/null 2>&1; then
            target_name="$page_name"
        else
            echo "Page '${page_name}' not found (full name: ${full_name})" >&2
            echo "$pages_json" | jq -r '.pages[]' 2>/dev/null | sed 's/^/  - /' >&2
            return 1
        fi
    fi

    local encoded_name
    encoded_name=$(printf '%s' "$target_name" | jq -sRr '@uri')
    local result
    result=$(curl -s -m 10 -X POST "http://localhost:${SERVER_PORT}/pages/${encoded_name}/resize" \
        -H "Content-Type: application/json" \
        -d "{\"width\":${width},\"height\":${height}}")

    if echo "$result" | jq -e '.success' >/dev/null 2>&1; then
        echo "Viewport resized to ${width}x${height}"
    else
        local error
        error=$(echo "$result" | jq -r '.error // "unknown error"' 2>/dev/null)
        echo "resize failed: $error" >&2
        return 1
    fi
}
