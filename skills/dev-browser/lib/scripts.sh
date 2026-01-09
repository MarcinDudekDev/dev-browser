#!/bin/bash
# Script management commands

cmd_run() {
    local script_name="$1"
    shift
    log_debug "--run '$script_name' from $(pwd)"

    local script_file=""
    if [[ -f "$BUILTIN_SCRIPTS_DIR/${script_name}.ts" ]]; then
        script_file="$BUILTIN_SCRIPTS_DIR/${script_name}.ts"
    elif [[ -f "$USER_SCRIPTS_DIR/${script_name}.ts" ]]; then
        script_file="$USER_SCRIPTS_DIR/${script_name}.ts"
    fi

    if [[ -z "$script_file" ]]; then
        log_debug "Script not found: $script_name"
        echo "Script not found: $script_name" >&2
        echo "Searched:" >&2
        echo "  $BUILTIN_SCRIPTS_DIR/${script_name}.ts" >&2
        echo "  $USER_SCRIPTS_DIR/${script_name}.ts" >&2
        echo "" >&2
        echo "Built-in scripts:" >&2
        ls -1 "$BUILTIN_SCRIPTS_DIR"/*.ts 2>/dev/null | xargs -I{} basename {} .ts | sed 's/^/  /'
        echo "" >&2
        echo "User scripts (use --list for full list):" >&2
        find "$USER_SCRIPTS_DIR" -maxdepth 2 -name "*.ts" 2>/dev/null | head -10 | sed "s|$USER_SCRIPTS_DIR/||" | sed 's/^/  /'
        return 1
    fi

    export SCRIPT_ARGS="$*"
    exec "$DEV_BROWSER_DIR/dev-browser.sh" "$script_file"
}

cmd_list() {
    echo "=== Built-in scripts ($BUILTIN_SCRIPTS_DIR) ==="
    ls -1 "$BUILTIN_SCRIPTS_DIR"/*.ts 2>/dev/null | while read f; do
        [[ "$(basename "$f")" == "start-server.ts" ]] && continue
        local name=$(basename "$f" .ts)
        local desc=$(head -1 "$f" | sed -n 's|^// *||p')
        [[ -z "$desc" ]] && desc="(no description)"
        printf "  %-20s %s\n" "$name" "$desc"
    done
    echo ""
    echo "=== User scripts ($USER_SCRIPTS_DIR) ==="
    find "$USER_SCRIPTS_DIR" -maxdepth 2 -name "*.ts" 2>/dev/null | sort | while read f; do
        local name=$(echo "$f" | sed "s|$USER_SCRIPTS_DIR/||" | sed 's/\.ts$//')
        local desc=$(head -1 "$f" | sed -n 's|^// *||p')
        [[ -z "$desc" ]] && desc=""
        printf "  %-30s %s\n" "$name" "$desc"
    done
}

cmd_scenarios() {
    echo "=== Available scenarios ($DEV_BROWSER_DIR/scenarios/examples/) ==="
    if [[ -d "$DEV_BROWSER_DIR/scenarios/examples" ]]; then
        find "$DEV_BROWSER_DIR/scenarios/examples" -name "*.yaml" -o -name "*.yml" 2>/dev/null | sort | while read f; do
            local name=$(basename "$f")
            local desc=$(grep "^description:" "$f" 2>/dev/null | head -1 | sed 's/^description: *//' | sed 's/^["\x27]//' | sed 's/["\x27]$//')
            [[ -z "$desc" ]] && desc="(no description)"
            printf "  %-30s %s\n" "$name" "$desc"
        done
    else
        echo "  No scenarios directory found"
    fi
}

cmd_scenario() {
    local scenario_file="$1"
    if [[ -z "$scenario_file" ]]; then
        echo "Usage: dev-browser.sh --scenario <file.yaml>" >&2
        echo "" >&2
        echo "Available scenarios (use --scenarios to list):" >&2
        find "$DEV_BROWSER_DIR/scenarios/examples" -name "*.yaml" -o -name "*.yml" 2>/dev/null | head -5 | xargs -I{} basename {} | sed 's/^/  /'
        return 1
    fi

    local SCENARIO_PATH=""
    if [[ -f "$scenario_file" ]]; then
        SCENARIO_PATH="$scenario_file"
    elif [[ -f "$DEV_BROWSER_DIR/scenarios/examples/$scenario_file" ]]; then
        SCENARIO_PATH="$DEV_BROWSER_DIR/scenarios/examples/$scenario_file"
    else
        echo "Scenario file not found: $scenario_file" >&2
        return 1
    fi

    start_server || return 1
    cd "$DEV_BROWSER_DIR" && exec bun x tsx src/scenario-runner.ts "$SCENARIO_PATH"
}
