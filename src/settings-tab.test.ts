/**
 * Tests for VaultSyncSettingTab diagnostics panel.
 *
 * Why these tests exist:
 * - renderDiagnostics() was tearing down and rebuilding the full DOM on every
 *   onDiagnosticsChange event. During an active sync, the engine fires ~20
 *   events per batch (per-doc), causing DOM thrash that freezes the mobile
 *   WebView renderer.
 * - Fix: persist the <pre> element across renders, only update textContent.
 *   Coalescing via rAF was removed in #42 because rAF callbacks don't fire
 *   during sync on iOS Obsidian either — only synchronous renders work.
 *
 * These tests are written in RED first (TDD), before the implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type VaultSyncPlugin from "./main";
import type { SyncDiagnostics } from "./types";
import { VaultSyncSettingTab } from "./settings-tab";

// ---------------------------------------------------------------------------
// Minimal DOM mock — vitest environment is "node" (no jsdom available).
// We provide only what settings-tab.ts needs.
// ---------------------------------------------------------------------------

class MockStyle {
  userSelect = "";
  webkitUserSelect = "";
}

class MockHTMLElement {
  tagName: string;
  textContent = "";
  cls = "";
  // Track child elements appended
  children: MockHTMLElement[] = [];
  style = new MockStyle();
  // DOM parentElement reference — set when added as child, cleared when removed
  parentElement: MockHTMLElement | null = null;

  // Tracks all createEl calls made on this element
  private _createElCalls: { tag: string; opts?: { cls?: string; text?: string } }[] = [];

  constructor(tag: string, opts?: { cls?: string; text?: string }) {
    this.tagName = tag.toUpperCase();
    if (opts?.cls) this.cls = opts.cls;
    if (opts?.text) this.textContent = opts.text;
  }

  /** Obsidian extension: create child element, append, return it */
  createEl(tag: string, opts?: { cls?: string; text?: string }): MockHTMLElement {
    this._createElCalls.push({ tag, opts });
    const child = new MockHTMLElement(tag, opts);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  /** Obsidian extension: remove all children */
  empty(): void {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children = [];
    this.textContent = "";
  }

  /** DOM compatibility */
  appendChild(child: MockHTMLElement): MockHTMLElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  /** Returns the number of times createEl was called on this element (not descendants) */
  getCreateElCallCount(tag?: string): number {
    if (tag) {
      return this._createElCalls.filter((c) => c.tag === tag).length;
    }
    return this._createElCalls.length;
  }
}

// ---------------------------------------------------------------------------
// Obsidian Setting mock that counts constructor invocations
// ---------------------------------------------------------------------------

let settingConstructorCount = 0;

vi.mock("obsidian", async () => {
  const actual = await vi.importActual<typeof import("./__mocks__/obsidian")>(
    "./__mocks__/obsidian"
  );
  return {
    ...actual,
    Setting: class MockSetting {
      constructor(_el: unknown) {
        settingConstructorCount++;
      }
      setName(): this { return this; }
      setDesc(): this { return this; }
      addText(): this { return this; }
      addTextArea(): this { return this; }
      addButton(): this { return this; }
    },
  };
});

// ---------------------------------------------------------------------------
// Minimal plugin mock (mirrors makePlugin() pattern from main.test.ts)
// ---------------------------------------------------------------------------

function makeDiagnosticsSnapshot(overrides: Partial<SyncDiagnostics> = {}): SyncDiagnostics {
  return {
    running: false,
    state: "idle",
    revMapSize: 0,
    knownRevMapSize: 0,
    lastSeq: 0,
    pullProgress: null,
    pullSkipped: 0,
    pullApplied: 0,
    pendingPushCount: 0,
    lastError: null,
    unsyncableCount: 0,
    unsyncableSample: [],
    ...overrides,
  };
}

function makePluginMock(diagnosticsOverrides: Partial<SyncDiagnostics> = {}): VaultSyncPlugin {
  let diagnostics = makeDiagnosticsSnapshot(diagnosticsOverrides);
  const listeners = new Set<() => void>();

  const plugin = {
    settings: {
      couchDbUrl: "https://sync.example.com",
      couchDbName: "vault-test",
      couchDbUser: "user",
      couchDbPassword: "pass",
      syncDebounceMs: 500,
      excludePatterns: [],
    },
    getDiagnostics: vi.fn(() => diagnostics),
    subscribeDiagnostics: vi.fn((listener: () => void) => listeners.add(listener)),
    unsubscribeDiagnostics: vi.fn((listener: () => void) => listeners.delete(listener)),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue(true),
    forceFullSync: vi.fn().mockResolvedValue(undefined),
    resumeFullSync: vi.fn().mockResolvedValue(undefined),
    previewFullSync: vi.fn().mockResolvedValue(undefined),
    _setDiagnostics: (d: Partial<SyncDiagnostics>) => {
      diagnostics = { ...diagnostics, ...d };
    },
    _fireListeners: () => {
      for (const l of listeners) l();
    },
  };
  return plugin as unknown as VaultSyncPlugin;
}

// ---------------------------------------------------------------------------
// Helpers to make the settings tab work without real Obsidian/DOM
// ---------------------------------------------------------------------------

function makeTab(plugin: VaultSyncPlugin): VaultSyncSettingTab {
  const tab = Object.create(VaultSyncSettingTab.prototype) as VaultSyncSettingTab;
  // Inject a mock containerEl that supports createEl/empty
  const containerEl = new MockHTMLElement("div") as unknown as HTMLElement;
  (tab as unknown as { containerEl: HTMLElement }).containerEl = containerEl;
  (tab as unknown as { plugin: VaultSyncPlugin }).plugin = plugin;
  // Initialize private fields that display() expects
  (tab as unknown as { diagnosticsEl: null }).diagnosticsEl = null;
  (tab as unknown as { diagnosticsPre: null }).diagnosticsPre = null;
  (tab as unknown as { previewEl: null }).previewEl = null;
  (tab as unknown as { unsubDiagnostics: null }).unsubDiagnostics = null;
  return tab;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VaultSyncSettingTab — diagnostics no-teardown invariant", () => {
  let plugin: ReturnType<typeof makePluginMock> & VaultSyncPlugin;
  let tab: VaultSyncSettingTab;

  beforeEach(() => {
    settingConstructorCount = 0;
    plugin = makePluginMock() as ReturnType<typeof makePluginMock> & VaultSyncPlugin;
    tab = makeTab(plugin);
    tab.display();
    // Reset the count AFTER display() which builds the initial DOM
    settingConstructorCount = 0;
  });

  afterEach(() => {
    tab.hide();
    vi.clearAllTimers();
  });

  it("the <pre> element identity is stable after 50 diagnostics handler calls", () => {
    const preBefore = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre;
    expect(preBefore).not.toBeNull();

    // Simulate 50 rapid direct renderDiagnostics calls (subscription path, pre-throttle)
    const renderDiagnostics = (tab as unknown as { renderDiagnostics: () => void }).renderDiagnostics.bind(tab);
    for (let i = 0; i < 50; i++) {
      renderDiagnostics();
    }

    const preAfter = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre;
    expect(preAfter).toBe(preBefore); // same object reference
  });

  it("Setting (Copy button) is constructed exactly once across 50 renders", () => {
    const renderDiagnostics = (tab as unknown as { renderDiagnostics: () => void }).renderDiagnostics.bind(tab);
    for (let i = 0; i < 50; i++) {
      renderDiagnostics();
    }
    // Setting constructor should NOT have been called again (button already built)
    expect(settingConstructorCount).toBe(0);
  });
});

describe("VaultSyncSettingTab — diagnostics live render (sync)", () => {
  let plugin: ReturnType<typeof makePluginMock> & VaultSyncPlugin;
  let tab: VaultSyncSettingTab;

  beforeEach(() => {
    settingConstructorCount = 0;
    plugin = makePluginMock() as ReturnType<typeof makePluginMock> & VaultSyncPlugin;
    tab = makeTab(plugin);
    tab.display();
    // Reset counts AFTER display() which builds initial DOM and does initial render
    settingConstructorCount = 0;
    (plugin.getDiagnostics as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    tab.hide();
    vi.clearAllTimers();
  });

  it("10 handler calls produce exactly 10 getDiagnostics calls (no coalescing)", () => {
    for (let i = 0; i < 10; i++) {
      (plugin as unknown as { _fireListeners: () => void })._fireListeners();
    }
    // Sync render: every handler call immediately triggers a render
    expect(plugin.getDiagnostics).toHaveBeenCalledTimes(10);
  });

  it("pre.textContent reflects latest data immediately after a single handler call (no rAF needed)", () => {
    (plugin as unknown as { _setDiagnostics: (d: Partial<SyncDiagnostics>) => void })
      ._setDiagnostics({ state: "syncing", revMapSize: 12345 });

    // A single handler fire should synchronously update the pre
    (plugin as unknown as { _fireListeners: () => void })._fireListeners();

    const pre = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre;
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("syncing");
    expect(pre!.textContent).toContain("12345");
  });

  it("50 handler calls → Setting constructor count is still 0 (pre reused, no DOM rebuild)", () => {
    for (let i = 0; i < 50; i++) {
      (plugin as unknown as { _fireListeners: () => void })._fireListeners();
    }
    // settingConstructorCount was reset after display() — should remain 0
    expect(settingConstructorCount).toBe(0);
  });
});

describe("VaultSyncSettingTab — diagnostics text updates correctly", () => {
  let plugin: ReturnType<typeof makePluginMock> & VaultSyncPlugin;
  let tab: VaultSyncSettingTab;

  beforeEach(() => {
    plugin = makePluginMock() as ReturnType<typeof makePluginMock> & VaultSyncPlugin;
    tab = makeTab(plugin);
    tab.display();
  });

  afterEach(() => {
    tab.hide();
    vi.clearAllTimers();
  });

  it("pre.textContent matches formatDiagnostics output after a direct render call", () => {
    (plugin as unknown as { _setDiagnostics: (d: Partial<SyncDiagnostics>) => void })
      ._setDiagnostics({ state: "ok", revMapSize: 42, pendingPushCount: 3 });

    const renderDiagnostics = (tab as unknown as { renderDiagnostics: () => void }).renderDiagnostics.bind(tab);
    renderDiagnostics();

    const pre = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre;
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("ok");
    expect(pre!.textContent).toContain("42");
    expect(pre!.textContent).toContain("3");
  });
});


describe("VaultSyncSettingTab — detached-pre fallback (#39)", () => {
  let plugin: ReturnType<typeof makePluginMock> & VaultSyncPlugin;
  let tab: VaultSyncSettingTab;

  beforeEach(() => {
    settingConstructorCount = 0;
    plugin = makePluginMock() as ReturnType<typeof makePluginMock> & VaultSyncPlugin;
    tab = makeTab(plugin);
    tab.display();
  });

  afterEach(() => {
    tab.hide();
    vi.clearAllTimers();
  });

  it("orphaned pre is rebuilt and reattached on next render", () => {
    const diagnosticsEl = (tab as unknown as { diagnosticsEl: MockHTMLElement }).diagnosticsEl!;
    const preBefore = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre!;

    // Orphan the cached pre by removing it from diagnosticsEl.children
    // Also clear parentElement to mirror real DOM behavior when a node is detached.
    diagnosticsEl.children = diagnosticsEl.children.filter((c) => c !== preBefore);
    preBefore.parentElement = null;
    expect(diagnosticsEl.children).not.toContain(preBefore);

    // Trigger a render via handler — sync, no rAF needed
    (plugin as unknown as { _fireListeners: () => void })._fireListeners();

    const preAfter = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre!;
    // The pre must be a NEW element (old one was detached)
    expect(preAfter).not.toBe(preBefore);
    // And it must be attached to diagnosticsEl
    expect(diagnosticsEl.children).toContain(preAfter);
    // Content must reflect latest diagnostics
    expect(preAfter.textContent).toBeTruthy();
  });
});

describe("VaultSyncSettingTab — Last render timestamp in formatDiagnostics (#39)", () => {
  let plugin: ReturnType<typeof makePluginMock> & VaultSyncPlugin;
  let tab: VaultSyncSettingTab;

  beforeEach(() => {
    vi.useFakeTimers();
    plugin = makePluginMock() as ReturnType<typeof makePluginMock> & VaultSyncPlugin;
    tab = makeTab(plugin);
  });

  afterEach(() => {
    tab.hide();
    vi.useRealTimers();
  });

  it("formatDiagnostics output contains a Last render timestamp line", () => {
    const formatDiagnostics = (
      tab as unknown as { formatDiagnostics: (d: SyncDiagnostics) => string }
    ).formatDiagnostics.bind(tab);

    const output = formatDiagnostics(makeDiagnosticsSnapshot());
    // Must include a line matching "Last render: HH:MM:SS"
    expect(output).toMatch(/Last render: \d{1,2}:\d{2}:\d{2}/);
  });

  it("Last render timestamp changes between successive formatDiagnostics calls at different times", () => {
    const formatDiagnostics = (
      tab as unknown as { formatDiagnostics: (d: SyncDiagnostics) => string }
    ).formatDiagnostics.bind(tab);

    vi.setSystemTime(new Date("2024-01-15T13:42:17Z"));
    const output1 = formatDiagnostics(makeDiagnosticsSnapshot());

    vi.setSystemTime(new Date("2024-01-15T13:43:00Z"));
    const output2 = formatDiagnostics(makeDiagnosticsSnapshot());

    // Timestamps must differ when system time advanced
    const match1 = output1.match(/Last render: (.+)/);
    const match2 = output2.match(/Last render: (.+)/);
    expect(match1).not.toBeNull();
    expect(match2).not.toBeNull();
    expect(match1![1]).not.toBe(match2![1]);
  });
});

describe("VaultSyncSettingTab — formatDiagnostics throughput lines always visible (#52)", () => {
  // Eliminated hypotheses:
  //   H2 (getDiagnostics omits fields): sync-engine.ts:263-266 explicitly returns all four fields.
  //   H6 (stale build): grep -c "avgFetchMs" main.js returns 2 — code is shipped.
  // Culprit: the `if (d.avgFetchMs !== null)` conditional in formatDiagnostics hides the
  // instrumentation lines whenever no text-pull batches have completed (pullTextDocs ran
  // with an empty list, e.g. during the binary-only phase, or allDocsByKeys threw every time).
  // prod getDiagnostics() always returns avgFetchMs: null (never undefined), so the condition
  // is always false until the first successful batch — making the lines invisible precisely
  // when they would be most informative. The existing 1.13.4 test used undefined (not null)
  // via makeDiagnosticsSnapshot omission, so it never exercised the null path.

  it("Avg fetch line is present even when avgFetchMs is null (0 samples)", () => {
    const tab = Object.create(VaultSyncSettingTab.prototype) as VaultSyncSettingTab;
    const formatDiagnostics = (
      tab as unknown as { formatDiagnostics: (d: SyncDiagnostics) => string }
    ).formatDiagnostics.bind(tab);

    const d: SyncDiagnostics = {
      running: true,
      state: "syncing",
      revMapSize: 8072,
      knownRevMapSize: 8072,
      lastSeq: "72347-abc",
      pullProgress: null,
      pullSkipped: 0,
      pullApplied: 0,
      pendingPushCount: 0,
      lastError: null,
      unsyncableCount: 0,
      unsyncableSample: [],
      avgFetchMs: null,
      fetchSampleCount: 0,
      avgApplyMs: null,
      applySampleCount: 0,
    };

    const output = formatDiagnostics(d);
    expect(output).toMatch(/Avg fetch \(text pull\)/);
    expect(output).toContain("0 samples");
  });

  it("Avg apply line is present even when avgApplyMs is null (0 samples)", () => {
    const tab = Object.create(VaultSyncSettingTab.prototype) as VaultSyncSettingTab;
    const formatDiagnostics = (
      tab as unknown as { formatDiagnostics: (d: SyncDiagnostics) => string }
    ).formatDiagnostics.bind(tab);

    const d: SyncDiagnostics = {
      running: true,
      state: "syncing",
      revMapSize: 8072,
      knownRevMapSize: 8072,
      lastSeq: "72347-abc",
      pullProgress: null,
      pullSkipped: 0,
      pullApplied: 0,
      pendingPushCount: 0,
      lastError: null,
      unsyncableCount: 0,
      unsyncableSample: [],
      avgFetchMs: null,
      fetchSampleCount: 0,
      avgApplyMs: null,
      applySampleCount: 0,
    };

    const output = formatDiagnostics(d);
    expect(output).toMatch(/Avg apply:/);
    expect(output).toContain("0 samples");
  });
});
