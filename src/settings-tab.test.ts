/**
 * Tests for VaultSyncSettingTab diagnostics panel.
 *
 * Why these tests exist:
 * - renderDiagnostics() was tearing down and rebuilding the full DOM on every
 *   onDiagnosticsChange event. During an active sync, the engine fires ~20
 *   events per batch (per-doc), causing DOM thrash that freezes the mobile
 *   WebView renderer.
 * - Two fixes: (1) persist the <pre> element across renders, only update
 *   textContent; (2) throttle the subscription handler to ~250 ms.
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
    this.children.push(child);
    return child;
  }

  /** Obsidian extension: remove all children */
  empty(): void {
    this.children = [];
    this.textContent = "";
  }

  /** DOM compatibility */
  appendChild(child: MockHTMLElement): MockHTMLElement {
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

describe("VaultSyncSettingTab — diagnostics throttle", () => {
  let plugin: ReturnType<typeof makePluginMock> & VaultSyncPlugin;
  let tab: VaultSyncSettingTab;

  beforeEach(() => {
    vi.useFakeTimers();
    settingConstructorCount = 0;
    plugin = makePluginMock() as ReturnType<typeof makePluginMock> & VaultSyncPlugin;
    tab = makeTab(plugin);
    tab.display();
  });

  afterEach(() => {
    tab.hide();
    vi.useRealTimers();
  });

  it("10 rapid onDiagnosticsChange events within 100ms produce fewer than 10 renders", () => {
    const renderSpy = vi.spyOn(
      tab as unknown as { renderDiagnostics: () => void },
      "renderDiagnostics"
    );

    // Fire 10 events via the subscribed handler (the throttled path)
    for (let i = 0; i < 10; i++) {
      (plugin as unknown as { _fireListeners: () => void })._fireListeners();
    }

    // Advance 100ms (within a typical 250ms throttle window)
    vi.advanceTimersByTime(100);

    // Events must be coalesced (fewer than 10 renders for 10 rapid events)
    expect(renderSpy.mock.calls.length).toBeLessThan(10);
  });

  it("the final diagnostics state IS rendered after the throttle window elapses", () => {
    const diagnosticsEl = (tab as unknown as { diagnosticsEl: MockHTMLElement }).diagnosticsEl;

    // Update diagnostics to a distinctive value
    (plugin as unknown as { _setDiagnostics: (d: Partial<SyncDiagnostics>) => void })
      ._setDiagnostics({ state: "syncing", revMapSize: 12345 });

    // Fire 10 rapid events
    for (let i = 0; i < 10; i++) {
      (plugin as unknown as { _fireListeners: () => void })._fireListeners();
    }

    // Advance past the throttle window (300ms > 250ms)
    vi.advanceTimersByTime(300);

    // The pre element's textContent must reflect the latest data
    const pre = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre;
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("syncing");
    expect(pre!.textContent).toContain("12345");
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
