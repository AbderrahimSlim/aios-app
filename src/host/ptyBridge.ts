/* aios-host side of the session supervisor: a `node-pty` stand-in whose ptys live in the supervisor
   process (src/host/supervisor.ts). The main process keeps calling `pty.spawn(...)` and gets an object
   with the same surface (pid, onData, onExit, write, resize, kill), so main.ts is unchanged.

   On connect the supervisor lists the ptys that survived a host restart (with what they printed in
   the meantime); the gateway offers them back to clients by name (gateway.ts, PtyRouter). */
import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { HOST_HOME, readOrCreateToken, supervisorAddress, SupPty } from './supervisor';

type Disposable = { dispose(): void };

export class ProxyPty {
  sid = 0;
  pid = 0;
  cols: number;
  rows: number;
  readonly process: string;
  handleFlowControl = false;
  private readonly ev = new EventEmitter();
  private pending: Array<Record<string, unknown>> = [];
  private exited = false;

  constructor(private readonly bridge: PtyBridge, file: string, cols = 80, rows = 24) {
    this.process = path.basename(file);
    this.cols = cols; this.rows = rows;
    this.ev.setMaxListeners(0);
  }
  /** Bound to a supervisor pty: flush what was asked before the id was known. */
  bind(sid: number, pid: number): void {
    this.sid = sid; this.pid = pid;
    for (const m of this.pending) this.bridge.send({ ...m, sid });
    this.pending = [];
  }
  private op(m: Record<string, unknown>): void {
    if (this.exited) return;
    if (this.sid) this.bridge.send({ ...m, sid: this.sid }); else this.pending.push(m);
  }
  onData(cb: (d: string) => void): Disposable { this.ev.on('data', cb); return { dispose: () => this.ev.off('data', cb) }; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): Disposable { this.ev.on('exit', cb); return { dispose: () => this.ev.off('exit', cb) }; }
  emitData(d: string): void { this.ev.emit('data', d); }
  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    this.ev.emit('exit', { exitCode, signal });
  }
  write(data: string): void { this.op({ op: 'write', data }); }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.op({ op: 'resize', cols, rows }); }
  kill(signal?: string): void { this.op({ op: 'kill', signal }); }
  clear(): void { /* windows-only in node-pty; nothing to do */ }
  pause(): void { /* flow control not used by the App */ }
  resume(): void { /* flow control not used by the App */ }
}

export class PtyBridge {
  private sock: net.Socket | null = null;
  private readonly bySid = new Map<number, ProxyPty>();
  private readonly byReq = new Map<number, ProxyPty>();
  private nextReq = 1;
  /** Set by the gateway right before it calls the spawn handler (which spawns synchronously). */
  nextMeta: Record<string, unknown> = {};
  /** Ptys that outlived the previous host, each already wrapped. */
  orphans: Array<{ pty: ProxyPty; rec: SupPty }> = [];

  send(m: Record<string, unknown>): void {
    if (this.sock && !this.sock.destroyed) this.sock.write(JSON.stringify(m) + '\n');
  }

  /** Connect, starting the supervisor if it is not running. Resolves once the supervisor has listed its ptys. */
  async connect(): Promise<void> {
    const token = readOrCreateToken();
    let sock = await this.tryConnect();
    if (!sock) {
      const entry = path.join(__dirname, 'supervisor.js');
      const child = spawnProcess(process.execPath, [entry], { detached: true, stdio: 'ignore', windowsHide: true, cwd: HOST_HOME, env: process.env });
      child.unref();
      for (let i = 0; i < 50 && !sock; i++) { await new Promise((r) => setTimeout(r, 100)); sock = await this.tryConnect(); }
      if (!sock) throw new Error('session supervisor did not start');
    }
    this.sock = sock;
    sock.setEncoding('utf8');
    let buf = '';
    let welcomed: () => void = () => undefined;
    const welcome = new Promise<void>((r) => { welcomed = r; });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: Record<string, unknown>;
        try { m = JSON.parse(line); } catch { continue; }
        this.onMessage(m, welcomed);
      }
    });
    sock.on('close', () => {
      /* The supervisor is gone, and every pty with it. */
      this.sock = null;
      for (const p of this.bySid.values()) p.emitExit(1);
      this.bySid.clear();
      console.error('[host] session supervisor connection lost');
    });
    sock.on('error', () => undefined);
    this.send({ op: 'hello', token });
    await welcome;
  }

  private tryConnect(): Promise<net.Socket | null> {
    return new Promise((resolve) => {
      const s = net.connect(supervisorAddress());
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(null));
    });
  }

  private onMessage(m: Record<string, unknown>, welcomed: () => void): void {
    switch (m.op) {
      case 'welcome':
        for (const rec of (m.ptys as SupPty[]) || []) {
          const p = new ProxyPty(this, String(rec.meta?.file || 'shell'), rec.cols, rec.rows);
          p.bind(rec.sid, rec.pid);
          this.bySid.set(rec.sid, p);
          this.orphans.push({ pty: p, rec });
        }
        welcomed();
        return;
      case 'spawned': {
        const p = this.byReq.get(Number(m.req));
        this.byReq.delete(Number(m.req));
        if (!p) return;
        this.bySid.set(Number(m.sid), p);
        p.bind(Number(m.sid), Number(m.pid));
        return;
      }
      case 'spawnFailed': {
        const p = this.byReq.get(Number(m.req));
        this.byReq.delete(Number(m.req));
        p?.emitExit(1);
        return;
      }
      case 'data': this.bySid.get(Number(m.sid))?.emitData(String(m.data)); return;
      case 'exit': {
        const p = this.bySid.get(Number(m.sid));
        this.bySid.delete(Number(m.sid));
        p?.emitExit(Number(m.exitCode) || 0, m.signal as number | undefined);
        return;
      }
    }
  }

  /** The `node-pty` module the main process sees in host mode. */
  module(): { spawn: (file: string, args: string[] | string, opts: Record<string, unknown>) => ProxyPty } {
    return {
      spawn: (file, args, opts) => {
        const p = new ProxyPty(this, file, Number(opts?.cols) || 80, Number(opts?.rows) || 24);
        const req = this.nextReq++;
        this.byReq.set(req, p);
        const meta = { ...this.nextMeta, file };
        this.nextMeta = {};
        this.send({ op: 'spawn', req, file, args: Array.isArray(args) ? args : [args], opts, meta });
        return p;
      },
    };
  }
}

export function supervisorPid(): number | null {
  try { return Number(fs.readFileSync(path.join(HOST_HOME, 'supervisor.pid'), 'utf8')) || null; } catch { return null; }
}
