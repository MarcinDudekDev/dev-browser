# Dev-Browser Optimization Ideas

## Quick Wins
- [x] **Auto-cleanup on start** - Close orphaned `about:blank` tabs when server starts
- [x] **Cache project prefix** - `get_project_prefix()` spawns Python every call; cache per-session
- [x] **Health endpoint** - Add `/health` to server instead of parsing wsEndpoint from root response

## Medium Effort
- [ ] **Script template simplification** - The 50-line boilerplate in `runscript.sh` could be a precompiled module
- [ ] **Connection reuse** - Scripts reconnect each time; could keep connection alive for batch operations
- [ ] **Retry logic** - Auto-retry on transient failures (network hiccups, page not ready)

## Bigger Improvements
- [ ] **Session persistence** - Save page URLs to disk, restore on crash (beyond Chrome's restore)
- [ ] **Parallel screenshots** - `--responsive` takes 4 sequential screenshots; could parallelize
- [ ] **Screenshot compression** - Add optional lossy compression for smaller file sizes
