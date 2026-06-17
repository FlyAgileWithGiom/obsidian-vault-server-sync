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

// Captured onChange handlers keyed by the setting's display name, so tests can
// drive a specific field's onChange (e.g. "Username") and assert where it routes.
const capturedOnChange = new Map<string, (value: string) => unknown>();

/** Text-builder stub passed to addText() callbacks; chainable, records onChange. */
class MockTextBuilder {
  inputEl = { type: "text" };
  private name: string;
  constructor(name: string) {
    this.name = name;
  }
  setPlaceholder(): this { return this; }
  setValue(): this { return this; }
  onChange(cb: (value: string) => unknown): this {
    capturedOnChange.set(this.name, cb);
    return this;
  }
}

// Captured addButton callbacks keyed by the setting's display name and button text.
// Each entry is { buttonText, callback }.
const capturedButtons: { name: string; buttonText: string; callback: () => unknown }[] = [];

/** Button builder stub passed to addButton() callbacks; chainable, records onClick. */
class MockButtonBuilder {
  private _text = "";
  private _onClick: (() => unknown) | null = null;
  private _settingName: string;
  constructor(settingName: string) {
    this._settingName = settingName;
  }
  setButtonText(text: string): this {
    this._text = text;
    return this;
  }
  setDisabled(): this { return this; }
  onClick(cb: () => unknown): this {
    this._onClick = cb;
    capturedButtons.push({ name: this._settingName, buttonText: this._text, callback: cb });
    return this;
  }
}

vi.mock("obsidian", async () => {
  const actual = await vi.importActual<typeof import("./__mocks__/obsidian")>(
    "./__mocks__/obsidian"
  );
  return {
    ...actual,
    Setting: class MockSetting {
      private name = "";
      constructor(_el: unknown) {
        settingConstructorCount++;
      }
      setName(name: string): this {
        this.name = name;
        return this;
      }
      setDesc(): this { return this; }
      addText(cb?: (text: MockTextBuilder) => unknown): this {
        if (cb) cb(new MockTextBuilder(this.name));
        return this;
      }
      addTextArea(cb?: (text: MockTextBuilder) => unknown): this {
        if (cb) cb(new MockTextBuilder(this.name));
        return this;
      }
      addButton(cb?: (btn: MockButtonBuilder) => unknown): this {
        const btn = new MockButtonBuilder(this.name);
        if (cb) cb(btn);
        return this;
      }
      addDropdown(): this { return this; }
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
    syncPhase: "idle",
    pullProgress: null,
    pullApplied: 0,
    binaryProgress: null,
    lastError: null,
    reconcileConflicts: 0,
    ...overrides,
  };
}

function makePluginMock(diagnosticsOverrides: Partial<SyncDiagnostics> = {}): VaultSyncPlugin {
  let diagnostics = makeDiagnosticsSnapshot(diagnosticsOverrides);
  const listeners = new Set<() => void>();

  const plugin = {
    manifest: { version: "0.0.0-test" },
    settings: {
      couchDbUrl: "https://sync.example.com",
      couchDbName: "vault-test",
      couchDbUser: "user",
      couchDbPassword: "pass",
      gatewayUrl: "",
      excludePatterns: [],
    },
    getDiagnostics: vi.fn(() => diagnostics),
    getLocalDocCount: vi.fn().mockResolvedValue(0),
    subscribeDiagnostics: vi.fn((listener: () => void) => listeners.add(listener)),
    unsubscribeDiagnostics: vi.fn((listener: () => void) => listeners.delete(listener)),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    saveSecrets: vi.fn().mockResolvedValue(undefined),
    startClerkLogin: vi.fn().mockResolvedValue(undefined),
    isLoggedIntoGateway: vi.fn().mockResolvedValue(false),
    refreshIfVaultChanged: vi.fn().mockResolvedValue(false),
    testConnection: vi.fn().mockResolvedValue(true),
    forceFullSync: vi.fn().mockResolvedValue(undefined),
    resumeFullSync: vi.fn().mockResolvedValue(undefined),
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
      ._setDiagnostics({ state: "syncing", pullApplied: 12345 });

    // A single handler fire should synchronously update the pre
    (plugin as unknown as { _fireListeners: () => void })._fireListeners();

    const pre = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre;
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("syncing");
    // pullApplied is only shown when pullProgress is non-null — check state instead
    expect(pre!.textContent).toContain("Status: syncing");
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
      ._setDiagnostics({ state: "ok", syncPhase: "complete" });

    const renderDiagnostics = (tab as unknown as { renderDiagnostics: () => void }).renderDiagnostics.bind(tab);
    renderDiagnostics();

    const pre = (tab as unknown as { diagnosticsPre: MockHTMLElement }).diagnosticsPre;
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("ok");
    expect(pre!.textContent).toContain("complete");
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


describe("VaultSyncSettingTab — two-phase syncPhase + binary progress (#72)", () => {
  function bindFormat(): (d: SyncDiagnostics) => string {
    const tab = Object.create(VaultSyncSettingTab.prototype) as VaultSyncSettingTab;
    (tab as unknown as { plugin: { manifest: { version: string } } }).plugin = { manifest: { version: "0.0.0-test" } };
    return (tab as unknown as { formatDiagnostics: (d: SyncDiagnostics) => string }).formatDiagnostics.bind(tab);
  }

  it("renders the sync phase line for every phase value", () => {
    const formatDiagnostics = bindFormat();
    for (const phase of ["idle", "text-pull", "text-ready", "binary-backfill", "complete"] as const) {
      const output = formatDiagnostics(makeDiagnosticsSnapshot({ syncPhase: phase }));
      expect(output).toContain(`Sync phase: ${phase}`);
    }
  });

  it("surfaces 'Notes ready' at the text-ready phase so the user sees the win", () => {
    const formatDiagnostics = bindFormat();
    const output = formatDiagnostics(makeDiagnosticsSnapshot({ syncPhase: "text-ready", state: "syncing" }));
    expect(output).toContain("Sync phase: text-ready");
    expect(output).toMatch(/Notes ready/i);
  });

  it("renders 'Attachments: N / total' when binaryProgress is non-null (Pattern A path)", () => {
    const formatDiagnostics = bindFormat();
    const output = formatDiagnostics(
      makeDiagnosticsSnapshot({ syncPhase: "binary-backfill", binaryProgress: { fetched: 1500, total: 6750 } })
    );
    expect(output).toContain("Attachments: 1500 / 6750");
  });

  it("omits the attachments count line and never emits NaN when binaryProgress is null (Pattern B)", () => {
    const formatDiagnostics = bindFormat();
    const output = formatDiagnostics(
      makeDiagnosticsSnapshot({ syncPhase: "binary-backfill", binaryProgress: null })
    );
    // Pattern B has no honest N/total — do not fabricate one, and never surface NaN.
    expect(output).not.toContain("NaN");
    expect(output).not.toContain("Attachments:");
    // The phase line still tells the user binaries are backfilling.
    expect(output).toContain("Sync phase: binary-backfill");
  });
});

describe("VaultSyncSettingTab — manifest version in Diagnostics panel", () => {
  it("formatDiagnostics output contains 'Version: ' as the first line", () => {
    const plugin = makePluginMock() as ReturnType<typeof makePluginMock> & VaultSyncPlugin;
    // Provide a manifest version on the plugin mock
    (plugin as unknown as { manifest: { version: string } }).manifest = { version: "1.13.8" };

    const tab = Object.create(VaultSyncSettingTab.prototype) as VaultSyncSettingTab;
    (tab as unknown as { plugin: VaultSyncPlugin }).plugin = plugin;

    const formatDiagnostics = (
      tab as unknown as { formatDiagnostics: (d: SyncDiagnostics) => string }
    ).formatDiagnostics.bind(tab);

    const output = formatDiagnostics(makeDiagnosticsSnapshot());
    expect(output).toContain("Version: ");
    expect(output.split("\n")[0]).toMatch(/^Version: /);
  });
});

// ---------------------------------------------------------------------------
// Non-secret config onChange still routes to saveSettings (Server URL)
// ---------------------------------------------------------------------------
//
// The legacy Username/Password fields were removed in #92 (Clerk login replaces
// Basic auth), so their onChange-routing tests are gone. Server URL still drives
// the legacy direct-CouchDB URL used as the Phase-A fallback, so it must continue
// to persist via saveSettings (non-secret config path).

describe("VaultSyncSettingTab — Server URL onChange routes to saveSettings", () => {
  let plugin: ReturnType<typeof makePluginMock> & VaultSyncPlugin;
  let tab: VaultSyncSettingTab;

  beforeEach(() => {
    capturedOnChange.clear();
    plugin = makePluginMock() as ReturnType<typeof makePluginMock> & VaultSyncPlugin;
    tab = makeTab(plugin);
    tab.display();
  });

  it("Server URL onChange still routes to saveSettings (non-secret config path unchanged)", async () => {
    const handler = capturedOnChange.get("Server URL");
    expect(handler).toBeTypeOf("function");

    await handler!("https://new.example.com");

    expect(plugin.settings.couchDbUrl).toBe("https://new.example.com");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(plugin.saveSecrets).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Clerk OAuth UI (#92): Gateway URL field, login button, status, no bootstrap
// ---------------------------------------------------------------------------

describe("VaultSyncSettingTab — Clerk OAuth UI (#92)", () => {
  function makeClerkPlugin(): VaultSyncPlugin & {
    startClerkLogin: ReturnType<typeof vi.fn>;
    isLoggedIntoGateway: ReturnType<typeof vi.fn>;
  } {
    const base = makePluginMock();
    const plugin = base as unknown as VaultSyncPlugin & {
      startClerkLogin: ReturnType<typeof vi.fn>;
      isLoggedIntoGateway: ReturnType<typeof vi.fn>;
    };
    (plugin as unknown as { settings: Record<string, unknown> }).settings.gatewayUrl = "";
    plugin.startClerkLogin = vi.fn().mockResolvedValue(undefined);
    plugin.isLoggedIntoGateway = vi.fn().mockResolvedValue(false);
    return plugin;
  }

  let plugin: ReturnType<typeof makeClerkPlugin>;
  let tab: VaultSyncSettingTab;

  beforeEach(() => {
    capturedOnChange.clear();
    plugin = makeClerkPlugin();
    tab = makeTab(plugin);
    tab.display();
  });

  afterEach(() => {
    tab.hide();
  });

  it("renders a Gateway URL field whose onChange persists via saveSettings", async () => {
    const handler = capturedOnChange.get("Gateway URL");
    expect(handler).toBeTypeOf("function");

    await handler!("https://mcp.fly-agile.com");

    expect((plugin.settings as unknown as { gatewayUrl: string }).gatewayUrl).toBe(
      "https://mcp.fly-agile.com",
    );
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("removes the legacy bootstrap / username / password credential fields", () => {
    // The old Basic-auth credential UI is replaced by Clerk login — those fields
    // must no longer route any onChange handler.
    expect(capturedOnChange.get("Username")).toBeUndefined();
    expect(capturedOnChange.get("Password")).toBeUndefined();
    expect(capturedOnChange.get("Bootstrap token")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Clerk OAuth UI — logout button (#87): shown only when signed in
// ---------------------------------------------------------------------------

describe("VaultSyncSettingTab — logout button (#87)", () => {
  function makeLoggedInPlugin(): VaultSyncPlugin & {
    logoutGateway: ReturnType<typeof vi.fn>;
    isLoggedIntoGateway: ReturnType<typeof vi.fn>;
  } {
    const base = makePluginMock();
    const plugin = base as unknown as VaultSyncPlugin & {
      logoutGateway: ReturnType<typeof vi.fn>;
      isLoggedIntoGateway: ReturnType<typeof vi.fn>;
    };
    plugin.logoutGateway = vi.fn().mockResolvedValue(undefined);
    plugin.isLoggedIntoGateway = vi.fn().mockResolvedValue(true);
    return plugin;
  }

  function makeLoggedOutPlugin(): VaultSyncPlugin & {
    logoutGateway: ReturnType<typeof vi.fn>;
    isLoggedIntoGateway: ReturnType<typeof vi.fn>;
  } {
    const base = makePluginMock();
    const plugin = base as unknown as VaultSyncPlugin & {
      logoutGateway: ReturnType<typeof vi.fn>;
      isLoggedIntoGateway: ReturnType<typeof vi.fn>;
    };
    plugin.logoutGateway = vi.fn().mockResolvedValue(undefined);
    plugin.isLoggedIntoGateway = vi.fn().mockResolvedValue(false);
    return plugin;
  }

  beforeEach(() => {
    capturedButtons.length = 0;
  });

  it("adds a sign-out button when isLoggedIntoGateway resolves true", async () => {
    const plugin = makeLoggedInPlugin();
    const tab = makeTab(plugin);
    tab.display();

    // isLoggedIntoGateway is async — wait for it to settle.
    await plugin.isLoggedIntoGateway();
    // Flush microtasks so the .then() callback runs.
    await Promise.resolve();

    const signOutButtons = capturedButtons.filter((b) =>
      b.buttonText.toLowerCase().includes("sign out") ||
      b.buttonText.toLowerCase().includes("log out"),
    );
    expect(signOutButtons.length).toBeGreaterThan(0);

    tab.hide();
  });

  it("does NOT add a sign-out button when isLoggedIntoGateway resolves false", async () => {
    const plugin = makeLoggedOutPlugin();
    const tab = makeTab(plugin);
    tab.display();

    await plugin.isLoggedIntoGateway();
    await Promise.resolve();

    const signOutButtons = capturedButtons.filter((b) =>
      b.buttonText.toLowerCase().includes("sign out") ||
      b.buttonText.toLowerCase().includes("log out"),
    );
    expect(signOutButtons.length).toBe(0);

    tab.hide();
  });

  it("calls logoutGateway when the sign-out button is clicked", async () => {
    const plugin = makeLoggedInPlugin();
    const tab = makeTab(plugin);
    tab.display();

    await plugin.isLoggedIntoGateway();
    await Promise.resolve();

    const signOutButton = capturedButtons.find((b) =>
      b.buttonText.toLowerCase().includes("sign out") ||
      b.buttonText.toLowerCase().includes("log out"),
    );
    expect(signOutButton).toBeDefined();

    await signOutButton!.callback();

    expect(plugin.logoutGateway).toHaveBeenCalledTimes(1);

    tab.hide();
  });
});
