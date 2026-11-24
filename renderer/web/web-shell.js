/* HOST MODE (browser) — give the page the same `window.glassShell` the desktop preload exposes, backed by
   a WebSocket to aios-host instead of Electron IPC (docs/rfcs/cloud-mode.md §5.4: "renderer unchanged
   where possible").

   The desktop preload itself (out/preload/preload.js, served wrapped as window.__AIOS_PRELOAD__) is run
   here UNMODIFIED against a small `electron` stand-in, so every glassShell method keeps its exact
   channel and argument shape and stays in step with upstream for free. Client-side capabilities stay
   in the browser and are named as such: clipboard, opening a URL, devtools, zoom. */
(function () {
  'use strict';
  const HOST = window.__AIOS_HOST__ || { platform: 'linux', version: '0.0.0', protocol: 1 };

  // ── binary-safe JSON (mirrors src/host/protocol.ts) ──────────────────────────────────────────
  function bytesToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBuffer(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8.buffer;
  }
  function encode(m) {
    return JSON.stringify(m, (_k, v) => {
      if (v instanceof ArrayBuffer) return { __b64: bytesToB64(new Uint8Array(v)) };
      if (ArrayBuffer.isView(v)) return { __b64: bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
      return v;
    });
  }
  function decode(raw) {
    return JSON.parse(raw, (_k, v) => (v && typeof v === 'object' && typeof v.__b64 === 'string' && Object.keys(v).length === 1 ? b64ToBuffer(v.__b64) : v));
  }

  // ── status pill: the operator must always know whether the host is reachable ─────────────────
  let pill = null;
  function status(text, tone) {
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => status(text, tone), { once: true }); return; }
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'aios-host-status';
      pill.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483647;padding:4px 10px;border-radius:999px;font:12px system-ui,sans-serif;pointer-events:none;transition:opacity .4s';
      document.body.appendChild(pill);
    }
    pill.textContent = text;
    pill.style.background = tone === 'ok' ? 'rgba(46,160,67,.85)' : tone === 'warn' ? 'rgba(210,153,34,.9)' : 'rgba(248,81,73,.9)';
    pill.style.color = '#fff';
    pill.style.opacity = '1';
    if (tone === 'ok') setTimeout(() => { if (pill.textContent === text) pill.style.opacity = '0'; }, 2500);
  }

  // ── the socket ──────────────────────────────────────────────────────────────────────────────
  let ws = null;
  let ready = false;
  let epoch = null;
  let nextId = 1;
  let retry = 0;
  const queue = [];                      // messages written before the socket was ready
  const pending = new Map();             // invoke id → { resolve, reject, ch }
  const listeners = new Map();           // channel → Set<fn>

  function write(m) {
    if (ready && ws && ws.readyState === WebSocket.OPEN) ws.send(encode(m));
    else queue.push(m);
  }

  function connect() {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    ws = new WebSocket(url);
    ws.onopen = () => { ws.send(encode({ t: 'hello', v: HOST.protocol })); };
    ws.onmessage = (e) => {
      let m;
      try { m = decode(e.data); } catch { return; }
      if (m.t === 'welcome') {
        if (epoch && epoch !== m.epoch) {
          /* The host restarted: its pane ids and watches are gone, so this page's view is stale. */
          status('Hôte redémarré — rechargement…', 'warn');
          setTimeout(() => location.reload(), 800);
          return;
        }
        epoch = m.epoch;
        ready = true;
        retry = 0;
        status('Connecté à l’hôte', 'ok');
        while (queue.length) ws.send(encode(queue.shift()));
        return;
      }
      if (m.t === 'res') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.v);
        else p.reject(new Error(`Error invoking remote method '${p.ch}': ${m.e}`));
        return;
      }
      if (m.t === 'ev') {
        if (m.ch === 'host:openExternal') { openUrl(m.a[0]); return; }
        const set = listeners.get(m.ch);
        if (set) for (const fn of [...set]) { try { fn({ sender: null }, ...m.a); } catch (err) { console.error(err); } }
        return;
      }
      if (m.t === 'bye') status(`Déconnecté : ${m.reason}`, 'err');
    };
    ws.onclose = (e) => {
      ready = false;
      /* Requests in flight will never be answered by this socket: fail them so callers do not hang. */
      for (const [id, p] of pending) { p.reject(new Error(`Error invoking remote method '${p.ch}': host connection lost`)); pending.delete(id); }
      if (e.code === 4001) { status('Appareil révoqué', 'err'); setTimeout(() => location.assign('/pair'), 1500); return; }
      if (e.code === 4002) { status('Version différente — rechargement…', 'warn'); setTimeout(() => location.reload(), 1500); return; }
      retry = Math.min(retry + 1, 6);
      status('Hôte injoignable — nouvelle tentative…', 'err');
      setTimeout(connect, 500 * 2 ** retry);
    };
  }

  const ipcRenderer = {
    invoke(ch, ...a) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, ch });
        write({ t: 'invoke', id, ch, a });
      });
    },
    send(ch, ...a) { write({ t: 'send', ch, a }); },
    on(ch, fn) { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(fn); return ipcRenderer; },
    once(ch, fn) { const w = (...x) => { ipcRenderer.removeListener(ch, w); fn(...x); }; return ipcRenderer.on(ch, w); },
    removeListener(ch, fn) { const s = listeners.get(ch); if (s) s.delete(fn); return ipcRenderer; },
    removeAllListeners(ch) { listeners.delete(ch); return ipcRenderer; },
  };

  function openUrl(url) {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') window.open(u.href, '_blank', 'noopener,noreferrer');
    } catch { /* not a URL */ }
  }

  // ── run the desktop preload against the socket ──────────────────────────────────────────────
  const electron = {
    contextBridge: { exposeInMainWorld: (key, api) => { window[key] = api; } },
    ipcRenderer,
    webUtils: { getPathForFile: () => '' },     // a browser never learns a dropped file's path (uploads come later)
  };
  const fakeRequire = (name) => {
    if (name === 'electron') return electron;
    throw new Error(`host mode: preload may not require '${name}'`);
  };
  const exportsObj = {};
  window.__AIOS_PRELOAD__(fakeRequire, exportsObj, { exports: exportsObj }, { env: {}, platform: HOST.platform, versions: {} });

  // ── client-side capabilities (RFC §5.4) ─────────────────────────────────────────────────────
  const gs = window.glassShell;
  if (gs) {
    gs.openExternal = async (url) => { openUrl(url); return true; };
    gs.copyText = async (t) => { try { await navigator.clipboard.writeText(String(t)); return true; } catch { return false; } };
    gs.copyPlainText = async (t) => gs.copyText(t);
    gs.readText = async () => { try { return await navigator.clipboard.readText(); } catch { return ''; } };
    gs.openDevTools = async () => false;
    gs.revealInOS = async () => false;
    gs.openPathExternal = async () => false;
    gs.hostMode = true;
  }
  /* Host-only features (Jarvis) talk on their own channels over the same socket. */
  window.__aiosIpc = ipcRenderer;

  connect();
})();
