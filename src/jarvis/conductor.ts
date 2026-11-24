/* JARVIS — the conductor: one persistent Claude Code session, driven over stream-json.

   `claude -p --input-format stream-json --output-format stream-json` stays open for the whole
   conversation; each operator utterance is one user message on stdin, and the reply streams back as
   events. Pattern taken from jarvis-gradium-starter (agents/claude_code.py), ported to TypeScript.

   Isolation (the "zero impact" contract): the session loads ONLY its own workspace's settings
   (`--setting-sources project`) and only the MCP servers of its own config (`--strict-mcp-config`).
   The operator's global hooks and MCP servers are never loaded, and nothing global is written.
   It runs in bypassPermissions as the operator asked; the guard hook and deny rules of the
   workspace (workspace.ts) still apply in that mode.

   The session id is kept in ~/.aios/host/jarvis-state.json so the conversation survives a restart
   (`--resume`); a resume that fails starts a fresh session. */
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toolSummary } from './speech';

export type ConductorEvent =
  | { type: 'turn_start' }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; summary: string }
  | { type: 'tool_done'; id: string; ok: boolean }
  | { type: 'turn_done'; costUsd?: number; ms?: number; error?: string }
  | { type: 'status'; state: 'starting' | 'ready' | 'busy' | 'stopped'; detail?: string };

export interface ConductorOptions {
  workspace: string;          // cwd: holds CLAUDE.md (persona) and .claude/settings.json (guard)
  addDirs: string[];          // e.g. the AIOS framework + vault
  stateFile: string;
  model?: string;             // default: sonnet (the alias tracks the latest Sonnet)
  effort?: string;            // default: high
  mcpConfig: string;
}

/** The real claude executable. On Windows the npm `.cmd` shim mangles arguments through cmd.exe, so the .exe is preferred. */
export function findClaude(): string {
  if (process.env.AIOS_CLAUDE_BIN) return process.env.AIOS_CLAUDE_BIN;
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude'];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

export class Conductor extends EventEmitter {
  private proc: ChildProcess | null = null;
  private sessionId: string | null = null;
  private busy = false;
  private queue: string[] = [];
  private reqSeq = 0;
  private resumeFailed = false;
  private stderrTail = '';
  /** This process answered at least once: a later failure is not a failed resume. */
  private gotResult = false;

  constructor(private readonly o: ConductorOptions) {
    super();
    try { this.sessionId = JSON.parse(fs.readFileSync(o.stateFile, 'utf8')).sessionId || null; } catch { this.sessionId = null; }
  }

  get isBusy(): boolean { return this.busy; }

  private emitEv(e: ConductorEvent): void { this.emit('event', e); }

  private start(): void {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', this.o.model || 'sonnet', '--effort', this.o.effort || 'high',
      '--permission-mode', 'bypassPermissions',
      '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', this.o.mcpConfig,
    ];
    for (const d of this.o.addDirs) args.push('--add-dir', d);
    /* The persona is passed explicitly: observed on 2.1.330, a -p session in this workspace did not follow
       its CLAUDE.md (searched the disk for the vault, answered in markdown). */
    const persona = path.join(this.o.workspace, 'CLAUDE.md');
    if (fs.existsSync(persona)) args.push('--append-system-prompt-file', persona);
    if (this.sessionId && !this.resumeFailed) args.push('--resume', this.sessionId);
    const env = { ...process.env };
    delete env.CLAUDE_CODE_CHILD_SESSION;          // an inherited marker would turn transcript saving off
    env.CLAUDE_AGENT_NAME = 'jarvis';
    this.emitEv({ type: 'status', state: 'starting' });
    const p = spawn(findClaude(), args, { cwd: this.o.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    this.gotResult = false;
    this.stderrTail = '';
    /* Writing to a child that failed to start or has exited raises EPIPE / ERR_STREAM_DESTROYED on stdin:
       never let that become an unhandled 'error' that takes the host down. */
    p.stdin!.on('error', () => undefined);
    let buf = '';
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { this.onLine(JSON.parse(line)); } catch { /* not JSON: ignore */ } }
      }
    });
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
    const ended = (detail: string | undefined, error: string) => {
      /* An old process (stopped by a reset) must not touch the state of the one that replaced it. */
      if (this.proc !== p) return;
      this.proc = null;
      const wasBusy = this.busy;
      this.busy = false;
      if (wasBusy) this.emitEv({ type: 'turn_done', error });
      /* A resume that dies before answering anything, because the conversation is unknown, is retried
         fresh, once. Any other failure keeps the session id: the conversation is not lost. */
      if (this.sessionId && !this.resumeFailed && !this.gotResult && /No conversation found/i.test(this.stderrTail)) {
        this.resumeFailed = true;
        this.sessionId = null;
        this.save();
      }
      this.emitEv({ type: 'status', state: 'stopped', detail });
      if (this.queue.length) this.pump();
    };
    p.on('exit', (code) => ended(code === 0 ? undefined : this.stderrTail.slice(-300), `session ended (code ${code}) ${this.stderrTail.slice(-300)}`));
    p.on('error', (err) => ended(String(err), `Jarvis could not start claude: ${String(err)}`));
    this.emitEv({ type: 'status', state: 'ready' });
  }

  private save(): void {
    try { fs.writeFileSync(this.o.stateFile, JSON.stringify({ sessionId: this.sessionId }, null, 2)); } catch { /* best effort */ }
  }

  private onLine(m: Record<string, any>): void {
    if (typeof m.session_id === 'string' && m.session_id !== this.sessionId) { this.sessionId = m.session_id; this.save(); }
    if (m.parent_tool_use_id) return;                  // a sub-agent's own chatter is not the conductor speaking
    switch (m.type) {
      case 'stream_event': {
        const ev = m.event || {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) this.emitEv({ type: 'text', delta: ev.delta.text });
        return;
      }
      case 'assistant': {
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_use') this.emitEv({ type: 'tool', id: b.id, summary: toolSummary(b.name, b.input) });
        }
        return;
      }
      case 'user': {
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_result') this.emitEv({ type: 'tool_done', id: b.tool_use_id, ok: !b.is_error });
        }
        return;
      }
      case 'result': {
        this.gotResult = true;
        this.busy = false;
        this.emitEv({ type: 'turn_done', costUsd: m.total_cost_usd, ms: m.duration_ms, error: m.is_error ? String(m.result || m.subtype) : undefined });
        this.emitEv({ type: 'status', state: 'ready' });
        this.pump();
        return;
      }
    }
  }

  private pump(): void {
    if (this.busy || !this.queue.length) return;
    if (!this.proc) this.start();
    const text = this.queue.shift() as string;
    this.busy = true;
    this.emitEv({ type: 'turn_start' });
    this.emitEv({ type: 'status', state: 'busy' });
    this.proc!.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  }

  /** One operator utterance. Queued while a turn is running. */
  send(text: string): void {
    const t = String(text || '').trim();
    if (!t) return;
    this.queue.push(t);
    this.pump();
  }

  /** Stop the current turn (barge-in, "stop"): the session stays, the reply is cut. */
  interrupt(): void {
    this.queue = [];
    if (!this.proc || !this.busy) return;
    this.proc.stdin!.write(JSON.stringify({ type: 'control_request', request_id: `int-${++this.reqSeq}`, request: { subtype: 'interrupt' } }) + '\n');
  }

  /** A new conversation: forget the session id and end the process. */
  reset(): void {
    this.queue = [];
    this.sessionId = null;
    this.resumeFailed = false;
    this.save();
    this.stop();
  }

  stop(): void {
    const p = this.proc;
    this.busy = false;
    if (!p) return;
    this.proc = null;
    try {
      if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      else p.kill('SIGTERM');
    } catch { /* gone */ }
  }
}
