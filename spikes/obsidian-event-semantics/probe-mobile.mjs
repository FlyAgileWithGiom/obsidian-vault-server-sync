// Mobile variant of the event-semantics probe.
//
// Uses Obsidian's built-in `app.emulateMobile(true)` to flip Platform.isMobile and
// activate the MOBILE code paths inside the desktop app, then re-runs the same
// folder delete / trash / rename / external-rm experiment. emulateMobile reloads the
// renderer, so we set it, wait, reconnect to the new page target, confirm isMobile,
// then run.
import { rmSync } from "node:fs";

const PORT = 9222;
const VAULT = "/Users/guillaume/.claude/jobs/0e3e224f/tmp/obs-probe-vault";
const log = (...a) => console.error("[probe-mobile]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl &&
               (t.url?.startsWith("app://") || /obsidian/i.test(t.url || t.title || "")),
      );
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error("No Obsidian page target on CDP");
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
}

async function connect() {
  const page = await findPageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const send = cdp(ws);
  await send("Runtime.enable");
  return { ws, send };
}

async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const SETUP = `(async () => {
  if (typeof app === 'undefined' || !app.vault) return { appReady: false };
  if (!window.__probeReady) {
    window.__ev = []; window.__refs = [];
    for (const ev of ['create','modify','delete','rename'])
      window.__refs.push(app.vault.on(ev, (f, oldPath) =>
        window.__ev.push({ ev, path: f && f.path, isFolder: !!(f && f.children), oldPath: oldPath || null })));
    window.__probeReady = true;
  }
  return { appReady: true, isMobile: !!app.isMobile,
           watched: app.vault.getAllLoadedFiles().map(f => f.path).filter(p => /^[FGHX](\\/|$)/.test(p)) };
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
  await run('vault.delete(F)',           () => app.vault.delete(app.vault.getAbstractFileByPath('F'), true));
  await run('vault.trash(G,false)',      () => app.vault.trash(app.vault.getAbstractFileByPath('G'), false));
  await run('fileManager.rename(H->H2)', () => app.fileManager.renameFile(app.vault.getAbstractFileByPath('H'), 'H2'));
  return out;
})()`;

const READ_X = `(async () => { const s=ms=>new Promise(r=>setTimeout(r,ms)); await s(1200);
  return window.__ev.filter(e => e.path && /^X(\\/|$)/.test(e.path)); })()`;

(async () => {
  // Step 1: set emulate mobile (triggers a renderer reload).
  let c = await connect();
  const setRes = await evaluate(c.send,
    `(typeof app !== 'undefined' && typeof app.emulateMobile === 'function')
       ? (app.emulateMobile(true), 'emulateMobile(true) called')
       : 'NO app.emulateMobile'`).catch((e) => "set-eval errored (likely reload): " + e.message);
  log("set mobile:", setRes);
  try { c.ws.close(); } catch {}

  // Step 2: wait for reload, reconnect.
  await sleep(9000);
  log("reconnecting after reload…");
  c = await connect();

  // Step 3: wait for app + vault ready under mobile mode.
  let setup;
  for (let i = 0; i < 30; i++) {
    setup = await evaluate(c.send, SETUP);
    if (setup.appReady && (setup.watched?.length ?? 0) > 0) break;
    await sleep(1000);
  }
  log("SETUP:", JSON.stringify(setup));

  const api = await evaluate(c.send, APITESTS);
  log("external rm -rf X");
  rmSync(VAULT + "/X", { recursive: true, force: true });
  const externalX = await evaluate(c.send, READ_X);

  console.log(JSON.stringify({ setMobile: setRes, setup, api, externalX }, null, 2));
  c.ws.close();
  process.exit(0);
})().catch((e) => { log("FATAL:", e.message); process.exit(1); });