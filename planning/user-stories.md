# planning/user-stories.md

### SYNC1: User's vault changes appear on CouchDB within seconds of saving

**User**: Obsidian user editing notes on any device
**Outcome**: Local file changes (create, modify, delete, rename) push to CouchDB immediately via HTTP
**Context**: Current PouchDB-based live replication causes iOS instability. Direct HTTP push is lighter and more predictable.

**Acceptance Criteria**:
- File create/modify/delete/rename events trigger CouchDB document upsert/delete
- Changes are debounced (500ms) to avoid flooding during rapid edits
- Failed pushes are queued locally and retried automatically
- Status ribbon shows upload activity

**Source**: USER_REQUEST (rebuild from scratch)

---

### SYNC2: User sees remote changes (from other devices) appear locally within 30 seconds

**User**: Obsidian user with vault open on multiple devices
**Outcome**: Remote CouchDB changes (from other devices or vault-server) appear as local files
**Context**: PouchDB's live `_changes` feed keeps persistent connections open, draining battery. Polling is more battery-friendly.

**Acceptance Criteria**:
- Plugin polls CouchDB `_changes` feed every 30 seconds (configurable)
- New/modified remote docs are written to local vault
- Deleted remote docs are removed locally
- Binary attachments are downloaded and written correctly
- Suppression mechanism prevents echo (re-syncing own changes)

**Source**: USER_REQUEST (rebuild from scratch)

---

### SYNC3: User continues editing offline and changes sync when connectivity returns

**User**: Obsidian mobile user with intermittent connectivity
**Outcome**: Changes made offline are persisted in a local queue and flushed when back online
**Context**: Current plugin silently drops changes when network is unavailable

**Acceptance Criteria**:
- Local change queue persisted via plugin saveData (survives app restart)
- Queue deduplicates by path (latest change wins)
- Queue is processed on reconnection and periodically
- Max 500 queued items (oldest dropped if exceeded)

**Source**: USER_REQUEST (mobile reliability)

---

### SYNC4: User syncs binary files (images, PDFs) alongside markdown notes

**User**: Obsidian user embedding images and attachments in notes
**Outcome**: Binary files sync to CouchDB as attachments, same as text files
**Context**: Must preserve existing attachment format (`_attachments.data.bin`)

**Acceptance Criteria**:
- Binary files detected by extension (non-text = binary)
- Binary content uploaded as CouchDB attachment with correct MIME type
- Files over maxBinarySize (20MB default) are skipped with warning
- Binary attachments from remote are downloaded and written locally

**Source**: EXISTING_FEATURE (preserve from v1)

---

### MOBILE1: Plugin loads instantly on iPhone without causing Obsidian reload loops

**User**: Obsidian iPhone user
**Outcome**: Plugin activates quickly with no heavy initialization blocking the UI thread
**Context**: PouchDB bundle (100KB+) and IndexedDB initialization cause slow loading and reload storms on iOS Safari/WebKit

**Acceptance Criteria**:
- Bundle size under 15KB (no PouchDB, no IndexedDB)
- Plugin `onload` completes in under 100ms
- No persistent WebSocket/EventSource connections
- No local database initialization on startup

**Source**: USER_REQUEST (primary pain point)

---

### MOBILE2: Plugin preserves iPhone battery during extended idle periods

**User**: Obsidian iPhone user with app in background or idle
**Outcome**: Plugin uses minimal resources when not actively syncing
**Context**: PouchDB live replication maintains persistent connections, draining battery

**Acceptance Criteria**:
- No persistent connections (polling only, every 30s configurable)
- Poll timer uses standard setInterval (OS can throttle in background)
- No background IndexedDB operations
- Network requests limited to poll interval + event-driven pushes

**Source**: USER_REQUEST (battery drain)

---

### SETUP1: User configures CouchDB connection through plugin settings UI

**User**: Obsidian user setting up sync for the first time
**Outcome**: Standard Obsidian settings tab for entering CouchDB credentials
**Context**: Same UX as current plugin

**Acceptance Criteria**:
- Settings tab with: CouchDB URL, database name, username, password (masked), debounce ms, poll interval
- Settings persisted via Obsidian plugin data API
- Default database: "vault-v2-prod"
- Default debounce: 500ms, default poll: 30s

**Source**: EXISTING_FEATURE (preserve from v1)

---

### SETUP2: User bootstraps initial sync by pushing all local files to CouchDB

**User**: Obsidian user doing first-time sync or recovery
**Outcome**: Command to push entire vault contents to CouchDB
**Context**: Needed for initial population or re-sync after data loss

**Acceptance Criteria**:
- Obsidian command: "Bootstrap: push all local files to CouchDB"
- Processes files in batches to avoid overwhelming the server
- Shows progress via Obsidian Notice
- Respects exclusion patterns (.obsidian/, .trash/)

**Source**: EXISTING_FEATURE (preserve from v1)

---

### TECH1: Plugin bundle stays under 15KB (vs 137KB currently with PouchDB)

**User**: Developer maintaining the plugin
**Outcome**: Lightweight bundle using direct fetch to CouchDB HTTP API, zero runtime dependencies
**Context**: PouchDB alone is ~100KB. Direct HTTP via Obsidian's `requestUrl` eliminates this.

**Acceptance Criteria**:
- TypeScript source with esbuild bundler
- Only external: `obsidian` (provided by host)
- Production build under 15KB
- Zero npm runtime dependencies

**Source**: ARCHITECTURE_DECISION

---

### COMPAT1: Plugin reads and writes documents compatible with existing vault-v2-prod database

**User**: Existing vault-server and vault-sync users
**Outcome**: No migration needed - new plugin works with existing CouchDB data
**Context**: Existing doc format: `_id = "file/<path>"`, text content inline, binary as `_attachments.data.bin`

**Acceptance Criteria**:
- Doc IDs use `file/` prefix + path
- Text docs have: `_id, type:"file", content, mtime, ctime, size, deleted`
- Binary docs have: `_id, type:"file", mtime, ctime, size, _attachments.data.bin`
- Excluded paths: `.obsidian/`, `.trash/`
- Text extensions: md, json, yaml, yml, xml, html, css, js, ts, csv, svg, etc.

**Source**: COMPATIBILITY_REQUIREMENT
