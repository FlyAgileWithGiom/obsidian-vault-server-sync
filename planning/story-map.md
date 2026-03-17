# planning/story-map.md

## Epic 1: Core Sync Engine (Critical - Sprint 1)

**Goal**: Replace PouchDB with lightweight direct CouchDB HTTP sync
**Business Value**: Plugin works reliably on iPhone, loads fast, preserves battery

```
SYNC: Bidirectional CouchDB Sync
├── SYNC1: User's vault changes appear on CouchDB within seconds (2h)
│   └── Event-driven push via HTTP on file create/modify/delete/rename
├── SYNC2: Remote changes appear locally within 30 seconds (2h)
│   └── Periodic polling of CouchDB _changes feed
├── SYNC3: Offline changes sync when connectivity returns (1.5h)
│   └── Persistent local queue with dedup and retry
└── SYNC4: Binary files sync alongside markdown (1h)
    └── Attachments with correct MIME types, size limits
```

**Total Effort**: 6.5 hours
**Impact**: Full bidirectional sync without PouchDB, zero runtime dependencies

---

## Epic 2: Mobile Experience (Critical - Sprint 1)

**Goal**: Eliminate iOS reload loops and battery drain
**Business Value**: Plugin usable on iPhone as daily driver

```
MOBILE: iPhone-First Performance
├── MOBILE1: Plugin loads instantly without reload loops (1h)
│   └── Sub-15KB bundle, no IndexedDB, fast onload
└── MOBILE2: Battery preserved during idle (0.5h)
    └── Polling instead of persistent connections
```

**Total Effort**: 1.5 hours
**Impact**: iPhone goes from unusable to reliable daily use

---

## Epic 3: Setup & Configuration (Standard - Sprint 1)

**Goal**: User can configure and bootstrap sync
**Business Value**: Same UX as current plugin, smooth onboarding

```
SETUP: Configuration & Bootstrap
├── SETUP1: CouchDB connection via settings UI (1h)
│   └── Standard Obsidian SettingTab with all fields
└── SETUP2: Bootstrap push of entire vault (1h)
    └── Batched file upload with progress notices
```

**Total Effort**: 2 hours
**Impact**: Zero-friction setup for new and existing users

---

## Epic 4: Technical Foundation (Enabler - Sprint 1)

**Goal**: Clean TypeScript codebase with minimal bundle
**Business Value**: Maintainable, lightweight, compatible

```
TECH: Architecture & Compatibility
├── TECH1: Bundle under 15KB with zero dependencies (1h)
│   └── TypeScript + esbuild, external obsidian only
└── COMPAT1: Compatible with existing vault-v2-prod data (0.5h)
    └── Same doc ID format, same schema, same exclusions
```

**Total Effort**: 1.5 hours
**Impact**: 90% bundle size reduction, zero migration needed
