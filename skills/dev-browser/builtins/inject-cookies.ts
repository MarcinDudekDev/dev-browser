// Inject cookies from Cookie Bridge into browser context
// Fast path: scripts/inject-cookies.sh handles this via curl (no tsx needed)
// This .ts stub exists only as the fallback entry point for run_script()
console.error("inject-cookies should use the .sh fast path");
process.exit(99); // Signal to fall through to .sh
