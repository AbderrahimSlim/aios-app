/* HOST MODE — the HTTP + WebSocket gateway in front of the unmodified main process.

   HTTP serves the renderer exactly as the desktop app loads it (renderer/, the few node_modules it
   links, the compiled preload), plus two host-made scripts that give the page a `window.glassShell`
   backed by this socket instead of Electron IPC. Every route but pairing needs a paired device.

   Security (RFC §7): binds to loopback by default (reach it through `tailscale serve`, which adds
   TLS); a WebSocket is accepted only with a paired device's cookie AND an Origin equal to the page's
   own host, so a web page the operator visits cannot drive the host; messages are shape-checked and
   size-limited; revoking a device closes its sockets within seconds. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { DeviceStore, parseCookies } from './auth';
import { FakeWebContents, ipcMain, setBroadcast } from './electronShim';
import { ProxyPty, PtyBridge } from './ptyBridge';
import { NodeBroker } from './nodes';
import { asClientMsg, decode, encode, HostMsg, LIMITS, PROTOCOL_VERSION } from './protocol';
import { listSessions, safeHost, safeNext } from './mobile';

const COOKIE = 'aios_host';
/* SameSite=Lax, not Strict: Strict withholds the cookie when the page is opened from a link on another site
   (claude.ai, a chat, the Tailscale console), so a paired browser landed on /pair and was paired again.
   Lax only adds top-level GET navigations; the WebSocket still requires the cookie AND a same-host Origin,
   and the pairing POST its own Origin check. Each visit of / renews it, so a device in use never expires. */
function deviceCookie(value: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
}
const APP_ROOT = path.join(__dirname, '..', '..');

/** node_modules packages the renderer links to (renderer/index.html). Nothing else under node_modules is served. */
const MODULE_ALLOW = ['@xterm/xterm/', '@xterm/addon-fit/', '@xterm/addon-webgl/', '@xterm/addon-unicode11/', 'marked/', '@highlightjs/cdn-assets/'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface GatewayOptions { port: number; bind: string; home: string; platform: string; version: string; }

interface Client { ws: WebSocket; deviceId: string; wc: FakeWebContents; inflight: number; }

/* SESSIONS OUTLIVE THEIR CLIENT (RFC §5.1, §8 "client disconnects mid-session").
   Every pty is spawned with this router as its `e.sender`, so its output never depends on a socket.
   A pty is owned by the client that spawned it; when that client goes, the pty keeps running
   DETACHED and its output is kept (bounded). When a client then opens a terminal under the same
   name — the renderer's own restore and resume paths do exactly that — it gets the live pty back,
   with what it missed, instead of a second process under the same name. Nothing in app.js changes. */
const BUS_KINDS = new Set(['terminal', 'sendByName', 'closeByName', 'focusByName']);
const DETACHED_BUFFER_CHARS = 256 * 1024;
/** First id given to a pty that outlived the previous host (main.ts numbers its own from 1). */
const FOREIGN_BASE = 1_000_000;
interface PtyRec {
  id: number; name: string; owner: Client | null; buffer: string;
  /** Taken back by name: the renderer's following pty:run (its opening command) must not be typed into the live session. */
  swallowRun: boolean;
  /** A pty from before this host started: main.ts does not know it, so the gateway drives it itself. */
  foreign?: ProxyPty;
}
class PtyRouter {
  readonly wc: FakeWebContents;
  private readonly ptys = new Map<number, PtyRec>();
  constructor(private readonly toAll: (ch: string, a: unknown[]) => void, private readonly toOne: (c: Client, ch: string, a: unknown[]) => void) {
    this.wc = new FakeWebContents(false, (ch, a) => this.route(ch, a));
  }
  route(ch: string, a: unknown[]): void {
    const m = a[0] as { id?: number } | undefined;
    const rec = m && typeof m.id === 'number' ? this.ptys.get(m.id) : undefined;
    if (ch === 'pty:data' && rec) {
      if (rec.owner) this.toOne(rec.owner, ch, a);
      else rec.buffer = (rec.buffer + String((a[0] as { data: string }).data)).slice(-DETACHED_BUFFER_CHARS);
      return;
    }
    if (ch === 'pty:exit' && rec) {
      if (rec.owner) this.toOne(rec.owner, ch, a);
      this.ptys.delete(rec.id);
      return;
    }
    this.toAll(ch, a);                       // a toast or focus intent raised while spawning
  }
  /** Ptys that survived a host restart: detached, with what they printed, until a client asks for them by name. */
  addForeign(orphans: Array<{ pty: ProxyPty; rec: { sid: number; meta: Record<string, unknown>; tail: string } }>): void {
    for (const { pty, rec } of orphans) {
      const id = FOREIGN_BASE + rec.sid;
      const name = typeof rec.meta.name === 'string' && rec.meta.name ? rec.meta.name : 'terminal';
      this.ptys.set(id, { id, name, owner: null, buffer: rec.tail.slice(-DETACHED_BUFFER_CHARS), swallowRun: false, foreign: pty });
      pty.onData((data) => this.route('pty:data', [{ id, data }]));
      pty.onExit(({ exitCode }) => this.route('pty:exit', [{ id, exitCode }]));
    }
  }
  get(id: unknown): PtyRec | undefined { return typeof id === 'number' ? this.ptys.get(id) : undefined; }
  /** A detached live pty this client may take back, or undefined. */
  adopt(c: Client, name: string): PtyRec | undefined {
    const rec = [...this.ptys.values()].find((r) => !r.owner && r.name === name);
    if (rec) { rec.owner = c; rec.swallowRun = true; }
    return rec;
  }
  spawned(c: Client | null, id: unknown, name: string): void {
    if (typeof id === 'number') this.ptys.set(id, { id, name, owner: c, buffer: '', swallowRun: false });
  }
  /** The live pty a bus request names (latest first). */
  byName(name: string): PtyRec | undefined {
    return [...this.ptys.values()].reverse().find((r) => r.name === name);
  }
  /** A client's request mentions a pty: only its owner may drive it. */
  owns(c: Client, id: unknown): boolean {
    const rec = this.get(id);
    return !rec || rec.owner === c;
  }
  detach(c: Client): void {
    for (const r of this.ptys.values()) if (r.owner === c) r.owner = null;
  }
  flush(rec: PtyRec): void {
    if (!rec.owner || !rec.buffer) return;
    const data = rec.buffer;
    rec.buffer = '';
    this.toOne(rec.owner, 'pty:data', [{ id: rec.id, data }]);
  }
  list(): Array<{ id: number; name: string; attached: boolean }> {
    return [...this.ptys.values()].map((r) => ({ id: r.id, name: r.name, attached: !!r.owner }));
  }
  /** The same list as seen by one client: whether each pty is its own (the phone app may only open a
      pty that is free or already its own — opening one another page holds would start a duplicate). */
  listFor(wc: unknown): Array<{ id: number; name: string; attached: boolean; mine: boolean }> {
    return [...this.ptys.values()].map((r) => ({ id: r.id, name: r.name, attached: !!r.owner, mine: !!r.owner && r.owner.wc === wc }));
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  const h = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** A path under `base`, or null when `rel` tries to leave it. */
function under(base: string, rel: string): string | null {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function pairPage(error: string, next = '/'): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIOS — appairer cet appareil</title>
<style>body{font:16px system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#161b22;padding:2rem;border-radius:12px;max-width:22rem;width:90%}h1{font-size:1.2rem;margin:0 0 .5rem}
p{color:#9da7b3;font-size:.9rem}input{font:1.4rem monospace;letter-spacing:.15em;width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;text-transform:uppercase}
button{margin-top:1rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#2f81f7;color:#fff;font-size:1rem}.err{color:#f85149}</style></head>
<body><form method="post" action="/pair"><h1>Appairer cet appareil</h1>
<p>Sur l'hôte, lance <code>npm run host -- pair</code> et saisis le code affiché (valable 10 min, usage unique).<br><i>On the host, run <code>npm run host -- pair</code> and type the code.</i></p>
${error ? `<p class="err">${error}</p>` : ''}
<input name="code" autocomplete="one-time-code" autofocus placeholder="ABCD-EFGH" maxlength="12">
<input type="hidden" name="next" value="${safeNext(next)}">
<button type="submit">Appairer</button></form></body></html>`;
}

export class Gateway {
  private readonly devices: DeviceStore;
  private readonly clients = new Set<Client>();
  private readonly epoch = crypto.randomBytes(6).toString('hex');
  private seq = 0;
  private server!: http.Server;
  private readonly router: PtyRouter;
  /** aios-brain, when started: its setup page is served here (tailnet, paired devices). */
  brain: import('./brain').Brain | null = null;
  /** Nodes (PCs running jarvis-node) and their capability requests. */
  readonly nodes = new NodeBroker();
  /** Token of the loopback-only /internal API (file readable by the operator only). */
  readonly internalToken: string;
  /** The client that acted last: the one a bus request opens its pane in (never every client). */
  private active: Client | null = null;

  constructor(private readonly opts: GatewayOptions, private readonly bridge: PtyBridge) {
    /* In the constructor, not a field initializer: those run before `opts` is assigned (ES2022 class fields). */
    this.internalToken = (() => {
      const f = path.join(opts.home, 'internal.token');
      try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* create */ }
      const t = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(opts.home, { recursive: true });
      fs.writeFileSync(f, t, { mode: 0o600 });
      return t;
    })();
    this.devices = new DeviceStore(opts.home);
    const toAll = (ch: string, a: unknown[]) => { for (const c of this.clients) this.emit(c, ch, a); };
    /* Bus requests (open / send to / close a session) go to ONE client, or are fulfilled here when no
       page is open: a spawn must never open once per browser, nor wait for someone to open one. */
    setBroadcast((ch, a) => {
      const p = a[0] as { kind?: string } | undefined;
      if (ch === 'shell:intent' && p && BUS_KINDS.has(String(p.kind))) {
        const c = this.active && this.clients.has(this.active) ? this.active : [...this.clients].pop();
        if (c) this.emit(c, ch, a); else this.headless(p as Record<string, unknown>);
        return;
      }
      toAll(ch, a);
    });
    this.router = new PtyRouter(toAll, (c, ch, a) => this.emit(c, ch, a));
    this.router.addForeign(bridge.orphans);
    /* The phone app's Sessions tab: the Claude Code sessions registered on this machine (read only), and
       the host's own terminals, each marked free / this client's / held by another page. */
    ipcMain.handle('host:sessions', () => listSessions());
    ipcMain.handle('host:ptys', (e: { sender: unknown }) => this.router.listFor(e.sender));
  }

  /** Live ptys and whether a client is attached (for the CLI and health). */
  ptys(): Array<{ id: number; name: string; attached: boolean }> { return this.router.list(); }
  isLive(name: string): boolean { return !!this.router.byName(name); }
  liveCount(prefix: string): number { return this.router.list().filter((p) => p.name.startsWith(prefix)).length; }

  get store(): DeviceStore { return this.devices; }

  private emit(c: Client, ch: string, a: unknown[]): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    this.out(c, { t: 'ev', ch, a, s: ++this.seq });
  }

  private out(c: Client, m: HostMsg): void {
    try { c.ws.send(encode(m)); } catch { /* socket closing */ }
  }

  start(): Promise<void> {
    this.server = http.createServer((req, res) => { void this.http(req, res); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });
    const nodeWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.server.on('upgrade', (req, socket, head) => {
      /* A NODE (jarvis-node on a PC): bearer credential of a device paired with the role `node`, and no
         Origin at all — a browser always sends one, so no web page can pose as a node. */
      if (req.url === '/node') {
        const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1];
        const node = this.devices.verify(bearer);
        if (!node || node.role !== 'node' || req.headers.origin) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
        nodeWss.handleUpgrade(req, socket, head, (ws) => { this.devices.touch(node.id); this.nodes.attach(ws, node.id, node.name); });
        return;
      }
      const found = this.devices.verify(parseCookies(req.headers.cookie)[COOKIE]);
      const device = found && found.role !== 'node' ? found : null;
      const origin = String(req.headers.origin || '');
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { /* no or bad origin */ }
      if (!device || req.url !== '/ws' || !originHost || originHost !== req.headers.host) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, device.id));
    });
    /* A revoke from the CLI edits devices.json; close that device's sockets promptly (RFC §7). */
    setInterval(() => {
      const live = new Set(this.devices.list().map((d) => d.id));
      for (const c of this.clients) if (!live.has(c.deviceId)) { this.out(c, { t: 'bye', reason: 'revoked' }); c.ws.close(4001, 'revoked'); }
      this.nodes.dropMissing(live);
    }, 3000).unref();
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.bind, () => resolve());
    });
  }

  private connect(ws: WebSocket, deviceId: string): void {
    const c: Client = {
      ws, deviceId, inflight: 0,
      /* This connection's own "window contents": a handler's e.sender.send() answers this client only,
         and its file watches end when the socket does. */
      wc: new FakeWebContents(false, (ch, a) => this.emit(c, ch, a)),
    };
    this.clients.add(c);
    this.devices.touch(deviceId);
    ws.on('message', (data, isBinary) => {
      this.active = c;
      if (isBinary) { ws.close(1003, 'text only'); return; }
      let m;
      try { m = asClientMsg(decode(data.toString())); } catch { m = null; }
      if (!m) { ws.close(1008, 'bad message'); return; }
      if (m.t === 'hello') {
        if (m.v !== PROTOCOL_VERSION) { this.out(c, { t: 'bye', reason: `protocol ${m.v} != host ${PROTOCOL_VERSION}: reload the page` }); ws.close(4002, 'version'); return; }
        this.out(c, { t: 'welcome', v: PROTOCOL_VERSION, epoch: this.epoch, platform: this.opts.platform, version: this.opts.version });
        return;
      }
      const event = { sender: c.wc, senderFrame: { url: 'aios-host://renderer/index.html' }, processId: 0, frameId: 0, returnValue: undefined as unknown, reply: (ch: string, ...a: unknown[]) => c.wc.send(ch, ...a) };
      /* pty:write / resize / kill / run / cwd / record name a pty: only the client that owns it may drive it. */
      const ptyArg = m.ch.startsWith('pty:') ? (m.a[0] as { id?: unknown } | undefined) : undefined;
      const ptyId = ptyArg && typeof ptyArg === 'object' ? ptyArg.id : typeof m.a[0] === 'number' ? m.a[0] : undefined;
      if (m.ch !== 'pty:spawn' && ptyId !== undefined && !this.router.owns(c, ptyId)) {
        if (m.t === 'invoke') this.out(c, { t: 'res', id: m.id, ok: false, e: 'pty owned by another client' });
        return;
      }
      if (this.ptyOp(c, m)) return;
      if (m.t === 'send') {
        try { ipcMain.emit(m.ch, event, ...m.a); } catch (e) { console.error(`[host] send ${m.ch}:`, e); }
        return;
      }
      const { id, ch, a } = m;
      if (c.inflight >= LIMITS.maxInflight) { this.out(c, { t: 'res', id, ok: false, e: 'too many requests in flight' }); return; }
      if (ch === 'pty:spawn') { this.spawn(c, id, a, event); return; }
      const h = ipcMain.handlers.get(ch);
      if (!h) { this.out(c, { t: 'res', id, ok: false, e: `No handler registered for '${ch}'` }); return; }
      c.inflight++;
      Promise.resolve().then(() => h(event, ...a)).then(
        (v) => this.out(c, { t: 'res', id, ok: true, v }),
        (err) => this.out(c, { t: 'res', id, ok: false, e: String((err && err.message) || err) }),
      ).finally(() => { c.inflight--; });
    });
    ws.on('close', () => { this.clients.delete(c); this.router.detach(c); c.wc.destroy(); });
  }

  /** The pty requests the gateway answers itself: the opening command of a pty taken back (never typed
   *  into the live session), and every request for a pty from before this host started. */
  private ptyOp(c: Client, m: { t: 'invoke' | 'send'; ch: string; a: unknown[]; id?: number }): boolean {
    if (!m.ch.startsWith('pty:') || m.ch === 'pty:spawn') return false;
    const arg = m.a[0] as { id?: unknown; data?: unknown; cols?: unknown; rows?: unknown } | number | undefined;
    const rec = this.router.get(typeof arg === 'number' ? arg : arg?.id);
    if (!rec) return false;
    const reply = (v: unknown) => { if (m.t === 'invoke' && typeof m.id === 'number') this.out(c, { t: 'res', id: m.id, ok: true, v }); };
    if (m.ch === 'pty:run' && rec.swallowRun) { rec.swallowRun = false; reply(true); return true; }
    const f = rec.foreign;
    if (!f) return false;
    const o = (typeof arg === 'object' && arg) || {};
    switch (m.ch) {
      case 'pty:write': f.write(String(o.data ?? '')); break;
      case 'pty:resize': f.resize(Number(o.cols) || f.cols, Number(o.rows) || f.rows); break;
      case 'pty:kill': f.kill(); break;
      case 'pty:run': f.write(String((o as { cmd?: unknown }).cmd ?? '') + String.fromCharCode(13)); reply(true); return true;
      default: reply(null); return true;   // cwd, record…: not available for a pty from a previous host
    }
    reply(true);
    return true;
  }

  /** A bus request with no page open: do what the renderer would have done. */
  private headless(p: Record<string, unknown>): void {
    const name = String(p.name || '');
    const call = (ch: string, ...a: unknown[]) => ipcMain.handlers.get(ch)?.({ sender: this.router.wc }, ...a);
    const verdict = (ok: boolean, reason: string) => ipcMain.emit('bus:sendResult', { sender: this.router.wc }, { name, ok, reason });
    const rec = name ? this.router.byName(name) : undefined;
    const write = (data: string) => { if (!rec) return; if (rec.foreign) rec.foreign.write(data); else ipcMain.emit('pty:write', { sender: this.router.wc }, { id: rec.id, data }); };
    try {
      switch (p.kind) {
        case 'terminal': {
          this.bridge.nextMeta = { name, cmd: p.cmd };
          const id = call('pty:spawn', { cols: 140, rows: 40, cmd: p.cmd, cwd: p.cwd, name, bus: p.bus === true }) as number;
          this.router.spawned(null, id, name || 'terminal');
          /* The renderer runs the command once the terminal is sized; give the shell time to start. */
          setTimeout(() => { void call('pty:run', { id, cmd: p.cmd }); }, 2000);
          console.log(`[host] bus: opened "${name}" headless (pty ${id})`);
          return;
        }
        case 'sendByName': {
          if (!rec) { verdict(false, 'no live pane with that name on the host'); return; }
          write('[200~' + String(p.text || '') + '[201~');
          setTimeout(() => { write(String.fromCharCode(13)); verdict(true, 'delivered headless'); }, 250);
          return;
        }
        case 'closeByName': if (rec) { if (rec.foreign) rec.foreign.kill(); else ipcMain.emit('pty:kill', { sender: this.router.wc }, { id: rec.id }); } return;
        default: return;                                  // focusByName: nothing to show
      }
    } catch (e) { console.error('[host] headless bus request failed:', e); }
  }

  /** pty:spawn, routed: take back a detached live pty of the same name, or spawn one owned by this client. */
  private spawn(c: Client, reqId: number, a: unknown[], event: Record<string, unknown>): void {
    const opts = (a[0] && typeof a[0] === 'object' ? a[0] : {}) as { name?: unknown; cols?: number; rows?: number };
    const name = typeof opts.name === 'string' && opts.name ? opts.name : 'terminal';
    const back = this.router.adopt(c, name);
    if (back) {
      this.out(c, { t: 'res', id: reqId, ok: true, v: back.id });
      /* The renderer registers the pane right after the id comes back; replay once it has. */
      setTimeout(() => this.router.flush(back), 400);
      return;
    }
    this.bridge.nextMeta = { name, cmd: (opts as { cmd?: unknown }).cmd };
    const h = ipcMain.handlers.get('pty:spawn');
    if (!h) { this.out(c, { t: 'res', id: reqId, ok: false, e: "No handler registered for 'pty:spawn'" }); return; }
    c.inflight++;
    Promise.resolve().then(() => h({ ...event, sender: this.router.wc }, ...a)).then(
      (v) => { this.router.spawned(c, v, name); this.out(c, { t: 'res', id: reqId, ok: true, v }); },
      (err) => this.out(c, { t: 'res', id: reqId, ok: false, e: String((err && err.message) || err) }),
    ).finally(() => { c.inflight--; });
  }

  private async http(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://host');
    const secure = !isLoopbackHost(req.headers.host);
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

    if (url.pathname === '/pair') {
      /* The pairing page must NOT be served with `Referrer-Policy: no-referrer`: under that policy a browser
         sends `Origin: null` with the form's POST, and the same-origin check below refused every real browser
         (curl, which ignores the policy, passed). `same-origin` keeps the Origin for this form only. */
      const pageHeaders = { ...headers, 'Referrer-Policy': 'same-origin' };
      if (req.method === 'POST') {
        const origin = String(req.headers.origin || '');
        let ok = false;
        try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
        /* A browser that still withholds the Origin (privacy settings, extensions) proves the same origin with
           Sec-Fetch-Site, a header no web page can set. */
        if (!ok && (origin === '' || origin === 'null') && req.headers['sec-fetch-site'] === 'same-origin') ok = true;
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) break; }
        const form = new URLSearchParams(body);
        const code = form.get('code') || '';
        /* A node pairs from a program: role=node and NO Origin (a browser always sends one). It gets its
           credential as JSON instead of a cookie. */
        if (form.get('role') === 'node') {
          const cred = !req.headers.origin ? this.devices.pair(code, String(form.get('machine') || 'node').slice(0, 64), 'node') : null;
          res.writeHead(cred ? 200 : 403, { ...headers, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cred ? { credential: cred } : { error: this.devices.locked() ? 'locked: too many attempts' : 'invalid or expired code' }));
          return;
        }
        if (!ok) {
          console.warn(`[host] pairing refused: origin "${origin}" does not match host "${req.headers.host}"`);
          res.writeHead(403, { ...pageHeaders, 'Content-Type': MIME['.html'] });
          res.end(pairPage('Demande refusée : ouvre cette page directement à l’adresse de l’hôte, puis réessaie (le code n’a pas été utilisé).'));
          return;
        }
        const cookie = this.devices.pair(code, String(req.headers['user-agent'] || 'browser'));
        if (!cookie) {
          res.writeHead(403, { ...pageHeaders, 'Content-Type': MIME['.html'] });
          res.end(pairPage(this.devices.locked() ? 'Trop d’essais, réessaie dans 5 min.' : 'Code invalide ou expiré.'));
          return;
        }
        res.writeHead(303, {
          ...headers, Location: safeNext(form.get('next')),
          'Set-Cookie': deviceCookie(cookie, secure),
        });
        res.end();
        return;
      }
      /* Already paired: straight to the App, never a second pairing of the same browser. */
      const next = safeNext(url.searchParams.get('next'));
      const known = this.devices.verify(parseCookies(req.headers.cookie)[COOKIE]);
      if (known && known.role !== 'node') { res.writeHead(302, { ...headers, Location: next }); res.end(); return; }
      res.writeHead(200, { ...pageHeaders, 'Content-Type': MIME['.html'] });
      res.end(pairPage('', next));
      return;
    }

    /* The phone app's manifest and icons, BEFORE the device check: iOS fetches them when the page is
       added to the home screen, and they say nothing about the host. */
    if (url.pathname === '/manifest.webmanifest') {
      return this.serveFile(path.join(APP_ROOT, 'renderer', 'web', 'manifest.webmanifest'), res, headers);
    }
    if (url.pathname.startsWith('/web/icons/')) {
      const icon = under(path.join(APP_ROOT, 'renderer', 'web', 'icons'), url.pathname.slice('/web/icons/'.length));
      if (icon && icon.endsWith('.png')) return this.serveFile(icon, res, headers);
      res.writeHead(404, headers); res.end(); return;
    }

    /* Loopback-only API for host-side tools (the aios-nodes MCP server Jarvis uses), with a token file
       only the operator can read. Never reachable through tailscale serve: that arrives with a Host
       header naming the tailnet, and the token is required anyway. */
    if (url.pathname === '/internal/nodes') return this.internalNodes(req, res, headers);
    /* GitHub sends the browser back here after creating the aios-brain app. It is guarded by the single-use
       setup state, not by the device cookie (a cross-site redirect: do not rely on the cookie's SameSite). */
    if (url.pathname === '/brain/setup/done' && this.brain) {
      try {
        const login = await this.brain.setupDone(String(url.searchParams.get('code') || ''), String(url.searchParams.get('state') || ''));
        res.writeHead(303, { ...headers, Location: `/brain/setup?created=${encodeURIComponent(login)}` }); res.end();
      } catch (e) {
        res.writeHead(400, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`Configuration aios-brain : ${String((e as Error).message || e)}`);
      }
      return;
    }

    const viewer = this.devices.verify(parseCookies(req.headers.cookie)[COOKIE]);
    if (!viewer || viewer.role === 'node') {
      /* The installed phone app pairs INSIDE itself (an iOS home-screen app may not share Safari's cookies),
         then comes back to /m. */
      res.writeHead(302, { ...headers, Location: url.pathname === '/m' ? '/pair?next=%2Fm' : '/pair' });
      res.end();
      return;
    }
    if (url.pathname === '/m') {
      const html = this.mobileHtml(req.headers.host);
      res.writeHead(200, { ...headers, 'Content-Type': MIME['.html'], 'Set-Cookie': deviceCookie(parseCookies(req.headers.cookie)[COOKIE], secure) });
      res.end(html);
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(302, { ...headers, Location: '/renderer/index.html', 'Set-Cookie': deviceCookie(parseCookies(req.headers.cookie)[COOKIE], secure) });
      res.end();
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204, headers); res.end(); return; }
    if (url.pathname.startsWith('/brain/setup') && this.brain) return this.brainSetup(req, res, url, headers);
    if (url.pathname === '/hostfile') return this.hostFile(url.searchParams.get('p') || '', res, headers);
    if (url.pathname === '/web/boot.js') return this.text(res, MIME['.js'], this.bootScript());
    if (url.pathname === '/web/preload.js') return this.text(res, MIME['.js'], this.preloadScript());
    if (url.pathname === '/renderer/index.html') return this.text(res, MIME['.html'], this.indexHtml());

    let file: string | null = null;
    if (url.pathname.startsWith('/renderer/')) file = under(path.join(APP_ROOT, 'renderer'), url.pathname.slice('/renderer/'.length));
    else if (url.pathname.startsWith('/web/')) file = under(path.join(APP_ROOT, 'renderer', 'web'), url.pathname.slice('/web/'.length));
    else if (url.pathname.startsWith('/node_modules/')) {
      const rel = url.pathname.slice('/node_modules/'.length);
      if (MODULE_ALLOW.some((p) => rel.startsWith(p))) file = under(path.join(APP_ROOT, 'node_modules'), rel);
    }
    if (!file) { res.writeHead(404, headers); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file as string).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(file as string).pipe(res);
    });
  }

  /* The viewers' files (images, PDFs, HTML exports), which the desktop loads as file:// URLs. Only
     inside the roots the explorer may show (framework, vault, workspace folders), symlinks resolved.
     HTML and SVG are served SANDBOXED (a unique origin, no scripts): a page in the vault must never
     reach the app's glassShell, which a same-origin frame could. */
  private async hostFile(p: string, res: http.ServerResponse, headers: Record<string, string>): Promise<void> {
    const deny = () => { res.writeHead(404, headers); res.end(); };
    if (!p || !path.isAbsolute(p)) return deny();
    let real: string;
    try { real = await fs.promises.realpath(p); } catch { return deny(); }
    const rootsHandler = ipcMain.handlers.get('fs:roots');
    let roots: string[] = [];
    try {
      const r = (await rootsHandler?.({ sender: null })) as { framework?: string | null; vault?: string | null; workspace?: { path: string }[] } | undefined;
      roots = [r?.framework, r?.vault, ...(r?.workspace || []).map((w) => w.path)].filter((x): x is string => !!x);
    } catch { roots = []; }
    const inside = (await Promise.all(roots.map((r) => fs.promises.realpath(r).catch(() => null))))
      .some((r) => !!r && (real === r || real.startsWith(r + path.sep)));
    if (!inside) return deny();
    let st: fs.Stats;
    try { st = await fs.promises.stat(real); } catch { return deny(); }
    if (!st.isFile()) return deny();
    const ext = path.extname(real).toLowerCase();
    const type = ext === '.pdf' ? 'application/pdf' : MIME[ext] || 'application/octet-stream';
    const sandbox = ext === '.html' || ext === '.htm' || ext === '.svg' ? { 'Content-Security-Policy': 'sandbox' } : {};
    res.writeHead(200, { ...headers, ...sandbox, 'Content-Type': type, 'Content-Length': st.size });
    fs.createReadStream(real).pipe(res);
  }

  /** The aios-brain setup page (tailnet only, paired devices only): Funnel, GitHub App, connector URL. */
  private async brainSetup(req: http.IncomingMessage, res: http.ServerResponse, url: URL, headers: Record<string, string>): Promise<void> {
    const b = this.brain!;
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const sameOrigin = req.headers['sec-fetch-site'] === 'same-origin' || (() => { try { return new URL(String(req.headers.origin)).host === req.headers.host; } catch { return false; } })();
    let notice = '';
    if (url.pathname === '/brain/setup/funnel' && req.method === 'POST') {
      if (!sameOrigin) { res.writeHead(403, headers); res.end(); return; }
      const r = await b.funnel();
      notice = r.ok ? 'Exposition activée.' : `Funnel : ${r.out}`;
    }
    await b.ensurePublicBase();
    const fstatus = await b.funnelStatus();
    const funnelOn = fstatus.split(/\r?\n/).some((l) => l.startsWith(`${b.publicUrl} (Funnel on)`));
    const enableLink = /(https:\/\/login\.tailscale\.com\/f\/funnel\S*)/.exec(notice)?.[1];
    const tailnetBase = `${isLoopbackHost(req.headers.host) ? 'http' : 'https'}://${req.headers.host}`;
    const created = url.searchParams.get('created');
    const { state, manifest } = b.manifest(tailnetBase);
    const step = (done: boolean, title: string, body: string) => `<section class="${done ? 'done' : ''}"><h2>${done ? '✓' : '○'} ${title}</h2>${body}</section>`;
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>aios-brain — configuration</title>
<style>body{font:15px system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222}section{border:1px solid #ddd;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}section.done{opacity:.75}h2{font-size:1.05rem;margin:.2rem 0 .6rem}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px;word-break:break-all}button{padding:.5rem 1rem;border-radius:8px;border:0;background:#2f81f7;color:#fff;font-size:.95rem;cursor:pointer}.n{color:#b35c00}</style></head><body>
<h1>aios-brain</h1><p>Ton vault dans n'importe quelle conversation Claude (web, mobile, desktop). Seul ton compte GitHub peut s'y connecter.</p>
${notice ? `<p class="n">${esc(notice)}</p>` : ''}${created ? `<p class="n">GitHub App créée. Compte autorisé : <b>${esc(created)}</b>.</p>` : ''}
${step(funnelOn, '1. Exposer aios-brain (et lui seul) sur Internet', funnelOn ? `<p>Adresse publique : <code>${esc(b.publicUrl)}</code></p>` :
  `<p>Funnel doit être autorisé une fois pour ton tailnet${enableLink ? ` : <a href="${esc(enableLink)}" target="_blank" rel="noopener">autoriser Funnel</a>` : ' (le bouton te donnera le lien si besoin)'}, puis :</p>
   <form method="post" action="/brain/setup/funnel"><button>Activer l'exposition (port 443)</button></form>`)}
${step(b.configured, '2. Connexion par GitHub', b.configured ? `<p>GitHub App configurée${b ? '' : ''}.</p>` :
  `<p>Crée l'application GitHub qui vérifiera que c'est bien toi (aucune permission sur tes dépôts) :</p>
   <form method="post" action="https://github.com/settings/apps/new?state=${esc(state)}"><input type="hidden" name="manifest" value="${esc(manifest)}"><button>Créer la GitHub App</button></form>`)}
${step(false, '3. Ajouter le connecteur dans Claude', `<p>claude.ai → Paramètres → Connecteurs → <i>Ajouter un connecteur personnalisé</i> : nom <code>aios-brain</code>, URL :</p><p><code>${esc(b.connectorUrl)}</code></p><p>Il apparaît ensuite dans Claude mobile et desktop. La première utilisation te fait passer par GitHub.</p>`)}
</body></html>`;
    res.writeHead(200, { ...headers, 'Content-Type': MIME['.html'], 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'" });
    res.end(html);
  }

  private async internalNodes(req: http.IncomingMessage, res: http.ServerResponse, headers: Record<string, string>): Promise<void> {
    const remote = String(req.socket.remoteAddress || '');
    const given = Buffer.from(String(req.headers['x-aios-internal'] || ''));
    const want = Buffer.from(this.internalToken);
    const okToken = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote) || !isLoopbackHost(req.headers.host) || !okToken || req.method !== 'POST') {
      res.writeHead(403, headers); res.end(); return;
    }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 128 * 1024) { res.writeHead(413, headers); res.end(); return; } }
    let m: { op?: string; capability?: string; args?: Record<string, unknown>; target?: string; id?: string };
    try { m = JSON.parse(body); } catch { res.writeHead(400, headers); res.end(); return; }
    const reply = (v: unknown) => { res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (m.op === 'list') return reply({ nodes: this.nodes.list(), queue: this.nodes.queue(), activeMachine: this.nodes.activeMachine() });
    if (m.op === 'cancel' && m.id) return reply({ ok: this.nodes.cancel(m.id) });
    if (m.op === 'call' && m.capability) return reply(await this.nodes.call(String(m.capability), m.args || {}, m.target ? String(m.target) : null));
    res.writeHead(400, headers); res.end();
  }

  private serveFile(file: string, res: http.ServerResponse, headers: Record<string, string>): void {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  }

  /** The phone app. Its CSP names the socket's own wss:// origin explicitly, because older WebKit did
      not count ws:/wss: as `'self'`. */
  private mobileHtml(host: string | undefined): string {
    const h = safeHost(host);
    const ws = h ? ` wss://${h} ws://${h}` : '';
    return fs.readFileSync(path.join(APP_ROOT, 'renderer', 'web', 'mobile.html'), 'utf8').replaceAll('{{CONNECT}}', `'self'${ws}`);
  }

  private text(res: http.ServerResponse, type: string, body: string): void {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }

  /** renderer/index.html, plus the two scripts that create `window.glassShell` BEFORE any page script runs. */
  private indexHtml(): string {
    const html = fs.readFileSync(path.join(APP_ROOT, 'renderer', 'index.html'), 'utf8');
    const inject = '<script src="/web/boot.js"></script>\n<script src="/web/preload.js"></script>\n<script src="/web/web-shell.js"></script>\n';
    return html
      .replace(/(<script src="csp-report\.js"><\/script>)/, `$1\n${inject}`)
      .replace(/(<script src="app\.js"><\/script>)/, '$1\n<script src="/web/after-app.js"></script>\n<script src="/web/jarvis.js"></script>');
  }

  /** Facts the page needs synchronously at load (app.js reads glassShell.platform on its first line). */
  private bootScript(): string {
    return `window.__AIOS_HOST__ = ${JSON.stringify({ platform: this.opts.platform, version: this.opts.version, protocol: PROTOCOL_VERSION })};\n`;
  }

  /** The desktop preload, compiled and unmodified, run against the socket-backed `electron` that web-shell's loader provides. */
  private preloadScript(): string {
    const src = fs.readFileSync(path.join(APP_ROOT, 'out', 'preload', 'preload.js'), 'utf8');
    return `window.__AIOS_PRELOAD__ = function (require, exports, module, process) {\n${src}\n};\n`;
  }
}
