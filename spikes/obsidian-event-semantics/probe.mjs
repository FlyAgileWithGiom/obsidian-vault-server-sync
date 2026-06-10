// Obsidian event-semantics spike driver.
//
// Drives an isolated Obsidian instance (launched with --remote-debugging-port=9222)
// over the Chrome DevTools Protocol to answer: when a FOLDER is deleted / trashed /
// renamed / removed externally, does Obsidian fire vault.on('delete'|'rename') once
// per descendant file, or one coarse folder-level event?
//
// Zero deps: node 22 global fetch + WebSocket. Run AFTER Obsidian is launched.
import { rmSync } from "node:fs";

const PORT = 9222;
const VAULT = "/Users/guillaume/.claude/jobs/0e3e224f/tmp/obs-probe-vault";

const log = (...a) => console.error("[probe]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl &&
               (t.url?.startsWith("app://") || /obsidian/i.test(t.url || t.title || "")),
      );
      if (page) return page;
      log("waiting for Obsidian page target… targets:", targets.map((t) => `${t.type}:${t.url}`).join(", ") || "(none)");
    } catch (e) {
      log("CDP endpoint not up yet:", e.message);
    }
    await sleep(1000);
  }
  throw new Error("No Obsidian page target on CDP — is --remote-debugging-port honored?");
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, (msg) =>
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result),
      );
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
}

async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error("renderer eval threw: " + JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

const SETUP = `(async () => {
  if (typeof app === 'undefined' || !app.vault) return { appReady: false };
  if (!window.__probeReady) {
    window.__ev = [];
    window.__refs = [];
    for (const ev of ['create','modify','delete','rename']) {
      window.__refs.push(app.vault.on(ev, (f, oldPath) => {
        window.__ev.push({ ev, path: f && f.path, isFolder: !!(f && f.children), oldPath: oldPath || null });
      }));
    }
    window.__probeReady = true;
  }
  return { appReady: true, watched: app.vault.getAllLoadedFiles().map(f => f.path).filter(p => /^[FGHX](\\/|$)/.test(p)) };
})()`;

const APITESTS = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = [];
  const run = async (label, fn) => {
    const start = window.__ev.length;
    try { await fn(); } catch (e) { out.push({ label, error: String(e) }); return; }
    await sleep(800);
    out.push({ label, events: window.__ev.slice(start) });
  };
  await run('vault.delete(F)',            () => app.vault.delete(app.vault.getAbstractFileByPath('F'), true));
  await run('vault.trash(G,false)',       () => app.vault.trash(app.vault.getAbstractFileByPath('G'), false));
  await run('fileManager.rename(H->H2)',  () => app.fileManager.renameFile(app.vault.getAbstractFileByPath('H'), 'H2'));
  return out;
})()`;

const READ_X = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(1200);
  return window.__ev.filter(e => e.path && /^X(\\/|$)/.test(e.path));
})()`;

(async () => {
  const page = await findPageTarget();
  log("connecting:", page.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const send = cdp(ws);
  await send("Runtime.enable");

  // Wait for app + vault index to be ready.
  let setup;
  for (let i = 0; i < 30; i++) {
    setup = await evaluate(send, SETUP);
    if (setup.appReady && (setup.watched?.length ?? 0) > 0) break;
    log("app/vault not ready yet:", JSON.stringify(setup));
    await sleep(1000);
  }
  log("SETUP:", JSON.stringify(setup));

  const api = await evaluate(send, APITESTS);

  // External FS delete of X while Obsidian watches.
  log("external rm -rf", VAULT + "/X");
  rmSync(VAULT + "/X", { recursive: true, force: true });
  const externalX = await evaluate(send, READ_X);

  console.log(JSON.stringify({ setup, api, externalX }, null, 2));
  ws.close();
  process.exit(0);
})().catch((e) => {
  log("FATAL:", e.message);
  process.exit(1);
});