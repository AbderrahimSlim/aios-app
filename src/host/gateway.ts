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
import { asClientMsg, decode, encode, HostMsg, LIMITS, PROTOCOL_VERSION } from './protocol';

const COOKIE = 'aios_host';
const APP_ROOT = path.join(__dirname, '..', '..');

/** node_modules packages the renderer links to (renderer/index.html). Nothing else under node_modules is served. */
const MODULE_ALLOW = ['@xterm/xterm/', '@xterm/addon-fit/', '@xterm/addon-webgl/', '@xterm/addon-unicode11/', 'marked/', '@highlightjs/cdn-assets/'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

export interface GatewayOptions { port: number; bind: string; home: string; platform: string; version: string; }

interface Client { ws: WebSocket; deviceId: string; wc: FakeWebContents; inflight: number; }

/* SESSIONS OUTLIVE THEIR CLIENT (RFC §5.1, §8 "client disconnects mid-session").
   Every pty is spawned with this router as its `e.sender`, so its output never depends on a socket.
   A pty is owned by the client that spawned it; when that client goes, the pty keeps running
   DETACHED and its output is kept (bounded). When a client then opens a terminal under the same
   name — the renderer's own restore and resume paths do exactly that — it gets the live pty back,
   with what it missed, instead of a second process under the same name. Nothing in app.js changes. */
const DETACHED_BUFFER_CHARS = 256 * 1024;
interface PtyRec { id: number; name: string; owner: Client | null; buffer: string; }
class PtyRouter {
  readonly wc: FakeWebContents;
  private readonly ptys = new Map<number, PtyRec>();
  constructor(private readonly toAll: (ch: string, a: unknown[]) => void, private readonly toOne: (c: Client, ch: string, a: unknown[]) => void) {
    this.wc = new FakeWebContents(false, (ch, a) => this.route(ch, a));
  }
  private route(ch: string, a: unknown[]): void {
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
  /** A detached live pty this client may take back, or undefined. */
  adopt(c: Client, name: string): PtyRec | undefined {
    const rec = [...this.ptys.values()].find((r) => !r.owner && r.name === name);
    if (rec) rec.owner = c;
    return rec;
  }
  spawned(c: Client, id: unknown, name: string): void {
    if (typeof id === 'number') this.ptys.set(id, { id, name, owner: c, buffer: '' });
  }
  /** A client's request mentions a pty: only its owner may drive it. */
  owns(c: Client, id: unknown): boolean {
    const rec = typeof id === 'number' ? this.ptys.get(id) : undefined;
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

function pairPage(error: string): string {
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
<button type="submit">Appairer</button></form></body></html>`;
}

export class Gateway {
  private readonly devices: DeviceStore;
  private readonly clients = new Set<Client>();
  private readonly epoch = crypto.randomBytes(6).toString('hex');
  private seq = 0;
  private server!: http.Server;
  private readonly router: PtyRouter;

  constructor(private readonly opts: GatewayOptions) {
    this.devices = new DeviceStore(opts.home);
    const toAll = (ch: string, a: unknown[]) => { for (const c of this.clients) this.emit(c, ch, a); };
    setBroadcast(toAll);
    this.router = new PtyRouter(toAll, (c, ch, a) => this.emit(c, ch, a));
  }

  /** Live ptys and whether a client is attached (for the CLI and health). */
  ptys(): Array<{ id: number; name: string; attached: boolean }> { return this.router.list(); }

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
    this.server.on('upgrade', (req, socket, head) => {
      const device = this.devices.verify(parseCookies(req.headers.cookie)[COOKIE]);
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
      if (req.method === 'POST') {
        const origin = String(req.headers.origin || '');
        let ok = false;
        try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) break; }
        const code = new URLSearchParams(body).get('code') || '';
        const cookie = ok ? this.devices.pair(code, String(req.headers['user-agent'] || 'browser')) : null;
        if (!cookie) {
          res.writeHead(403, { ...headers, 'Content-Type': MIME['.html'] });
          res.end(pairPage(this.devices.locked() ? 'Trop d’essais, réessaie dans 5 min.' : 'Code invalide ou expiré.'));
          return;
        }
        res.writeHead(303, {
          ...headers, Location: '/',
          'Set-Cookie': `${COOKIE}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`,
        });
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': MIME['.html'] });
      res.end(pairPage(''));
      return;
    }

    if (!this.devices.verify(parseCookies(req.headers.cookie)[COOKIE])) {
      res.writeHead(302, { ...headers, Location: '/pair' });
      res.end();
      return;
    }
    if (url.pathname === '/') { res.writeHead(302, { ...headers, Location: '/renderer/index.html' }); res.end(); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204, headers); res.end(); return; }
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

  private text(res: http.ServerResponse, type: string, body: string): void {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }

  /** renderer/index.html, plus the two scripts that create `window.glassShell` BEFORE any page script runs. */
  private indexHtml(): string {
    const html = fs.readFileSync(path.join(APP_ROOT, 'renderer', 'index.html'), 'utf8');
    const inject = '<script src="/web/boot.js"></script>\n<script src="/web/preload.js"></script>\n<script src="/web/web-shell.js"></script>\n';
    return html.replace(/(<script src="csp-report\.js"><\/script>)/, `$1\n${inject}`);
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
