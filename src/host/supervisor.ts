/* aios-host SESSION SUPERVISOR — the process that owns every pty (docs/rfcs/cloud-mode.md §5.1).

   It runs apart from aios-host so that restarting the host (an upgrade, a crash) never kills a
   session: the ptys stay children of THIS process, and a new host reconnects and takes them back.
   It knows nothing about the App; it spawns, relays and buffers.

   Transport: newline-delimited JSON over a local socket (a named pipe on Windows, a unix socket
   elsewhere). The first message must carry the token from ~/.aios/host/supervisor.token, a file
   only the operator can read; nothing is sent before it. One host at a time: a newer connection
   replaces the older. While no host is connected, every pty keeps running and its output is kept
   (bounded), so the next host can replay what was missed.

   Started by the host when absent (detached). Exits by itself when it has had no pty and no host
   for ten minutes. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';

export const HOST_HOME = process.env.AIOS_HOST_HOME || path.join(os.homedir(), '.aios', 'host');
export const TOKEN_FILE = path.join(HOST_HOME, 'supervisor.token');
const TAIL_CHARS = 256 * 1024;
const IDLE_EXIT_MS = 10 * 60 * 1000;

export function supervisorAddress(): string {
  const user = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_-]/g, '_');
  return process.platform === 'win32' ? `\\\\.\\pipe\\aios-host-supervisor-${user}` : path.join(HOST_HOME, 'supervisor.sock');
}

export function readOrCreateToken(): string {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { /* create */ }
  fs.mkdirSync(HOST_HOME, { recursive: true });
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

export interface SupPty { sid: number; pid: number; meta: Record<string, unknown>; cols: number; rows: number; tail: string; }

/** Run the supervisor (only when this file is the entry point). */
function main(): void {
  const token = readOrCreateToken();
  const ptys = new Map<number, { p: pty.IPty; rec: SupPty }>();
  let host: net.Socket | null = null;
  let nextSid = 1;
  let idleSince = Date.now();

  const send = (m: unknown): void => { if (host && !host.destroyed) host.write(JSON.stringify(m) + '\n'); };

  const handle = (sock: net.Socket, m: Record<string, unknown>): void => {
    const sid = Number(m.sid);
    const e = ptys.get(sid);
    switch (m.op) {
      case 'spawn': {
        const o = (m.opts || {}) as pty.IPtyForkOptions;
        let p: pty.IPty;
        try { p = pty.spawn(String(m.file), (m.args as string[]) || [], o); }
        catch (err) { send({ op: 'spawnFailed', req: m.req, error: String(err) }); return; }
        const rec: SupPty = { sid: nextSid++, pid: p.pid, meta: (m.meta as Record<string, unknown>) || {}, cols: Number(o.cols) || 80, rows: Number(o.rows) || 24, tail: '' };
        ptys.set(rec.sid, { p, rec });
        p.onData((data) => {
          rec.tail = (rec.tail + data).slice(-TAIL_CHARS);
          send({ op: 'data', sid: rec.sid, data });
        });
        p.onExit(({ exitCode, signal }) => { ptys.delete(rec.sid); send({ op: 'exit', sid: rec.sid, exitCode, signal }); if (!ptys.size) idleSince = Date.now(); });
        send({ op: 'spawned', req: m.req, sid: rec.sid, pid: p.pid });
        return;
      }
      case 'write': if (e) e.p.write(String(m.data)); return;
      case 'resize': if (e) { try { e.p.resize(Number(m.cols), Number(m.rows)); e.rec.cols = Number(m.cols); e.rec.rows = Number(m.rows); } catch { /* exited */ } } return;
      case 'kill': if (e) { try { e.p.kill(m.signal ? String(m.signal) : undefined); } catch { /* gone */ } } return;
      case 'clearTail': if (e) e.rec.tail = ''; return;
      default: sock.destroy();
    }
  };

  const server = net.createServer((sock) => {
    let authed = false;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 32 * 1024 * 1024) { sock.destroy(); return; }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: Record<string, unknown>;
        try { m = JSON.parse(line); } catch { sock.destroy(); return; }
        if (!authed) {
          const given = Buffer.from(String(m.token || ''));
          const want = Buffer.from(token);
          if (m.op !== 'hello' || given.length !== want.length || !crypto.timingSafeEqual(given, want)) { sock.destroy(); return; }
          authed = true;
          if (host && host !== sock) host.destroy();          // one host at a time: the newest wins
          host = sock;
          /* Everything still running, with what it printed while no host listened. */
          send({ op: 'welcome', pid: process.pid, ptys: [...ptys.values()].map(({ rec }) => rec) });
          continue;
        }
        handle(sock, m);
      }
    });
    sock.on('close', () => { if (host === sock) { host = null; idleSince = Date.now(); } });
    sock.on('error', () => undefined);
  });

  const addr = supervisorAddress();
  if (process.platform !== 'win32') { try { fs.unlinkSync(addr); } catch { /* none */ } }
  server.listen(addr, () => {
    if (process.platform !== 'win32') { try { fs.chmodSync(addr, 0o600); } catch { /* best effort */ } }
    fs.writeFileSync(path.join(HOST_HOME, 'supervisor.pid'), String(process.pid));
  });
  server.on('error', (err) => { console.error('[supervisor]', err); process.exit(1); });

  setInterval(() => {
    if (!host && !ptys.size && Date.now() - idleSince > IDLE_EXIT_MS) process.exit(0);
  }, 30_000).unref();
}

if (require.main === module) main();
