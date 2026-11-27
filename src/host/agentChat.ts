/* HOST MODE — one question to one AIOS agent, for a local app (e.g. MyLittleCRM's chat panel).

   POST /internal/agent-chat (loopback, `x-aios-internal` token) with { agent, message, sessionId? } runs
   `claude -p` once in the vault, with the agent's file as appended system prompt, and streams NDJSON back:
     { type: 'text', text }        a piece of the answer
     { type: 'tool', name }        the agent is reading something
     { type: 'done', sessionId }   the answer is complete; pass sessionId back to continue the conversation
     { type: 'error', message }
   READ-ONLY by construction: the only built-in tools are Read/Grep/Glob, the only MCP servers are the
   ones given (MyLittleCRM's GET allowlist), and dontAsk denies anything not pre-allowed. */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findClaude } from '../jarvis/conductor';

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; sessionId: string | null }
  | { type: 'error'; message: string };

export interface McpServer { command: string; args: string[]; env?: Record<string, string>; }

export interface AgentChatOptions {
  framework: string;
  hostHome: string;
  mcpServers: Record<string, McpServer>;
  model?: string;
  effort?: string;
  /** Answers running at once; more are refused (one operator, a few tabs at most). */
  maxConcurrent?: number;
}

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SESSION_ID = /^[0-9a-f-]{8,64}$/i;
export const MAX_MESSAGE_CHARS = 8000;

/** The agent's file: the operator's custom agents first, then the bundled ones (aios/<domain>/). */
export function resolveAgent(framework: string, name: string): string | null {
  if (!AGENT_NAME.test(name)) return null;
  const agents = path.join(framework, 'agents');
  const custom = path.join(agents, 'custom', `${name}.md`);
  if (fs.existsSync(custom)) return custom;
  let domains: string[] = [];
  try { domains = fs.readdirSync(path.join(agents, 'aios')); } catch { return null; }
  for (const d of domains) {
    const f = path.join(agents, 'aios', d, `${name}.md`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** The CLI arguments of one answer. Pure, so the read-only guarantees are testable. */
export function chatArgs(o: { agentFile: string; mcpConfig: string; mcpNames: string[]; message: string; sessionId: string | null; model: string; effort: string }): string[] {
  const allowed = ['Read', 'Grep', 'Glob', ...o.mcpNames.map((n) => `mcp__${n}`)];
  const args = [
    '-p', o.message,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', o.model, '--effort', o.effort,
    '--tools', 'Read,Grep,Glob',
    '--allowedTools', allowed.join(','),
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', o.mcpConfig,
    '--append-system-prompt-file', o.agentFile,
  ];
  if (o.sessionId) args.push('--resume', o.sessionId);
  return args;
}

/** Reads one stream-json line of the CLI into the events sent to the app. */
export function eventsOf(line: Record<string, unknown>): ChatEvent[] {
  if (line.type === 'stream_event') {
    const ev = line.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; name?: string } } | undefined;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) return [{ type: 'text', text: ev.delta.text }];
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') return [{ type: 'tool', name: String(ev.content_block.name || '') }];
    return [];
  }
  if (line.type === 'result') {
    if (line.is_error || line.subtype !== 'success') return [{ type: 'error', message: String(line.result || line.subtype || 'échec de la réponse') }];
    return [{ type: 'done', sessionId: typeof line.session_id === 'string' ? line.session_id : null }];
  }
  return [];
}

export class AgentChat {
  private running = new Set<ChildProcess>();
  private readonly mcpConfig: string;

  constructor(private readonly o: AgentChatOptions) {
    this.mcpConfig = path.join(o.hostHome, 'agent-chat.mcp.json');
    fs.mkdirSync(o.hostHome, { recursive: true });
    fs.writeFileSync(this.mcpConfig, JSON.stringify({ mcpServers: o.mcpServers }, null, 2), { mode: 0o600 });
  }

  /** Runs one answer; `send` gets every event, the last one being `done` or `error`. Returns a stop function. */
  ask(input: { agent?: unknown; message?: unknown; sessionId?: unknown }, send: (e: ChatEvent) => void): () => void {
    const fail = (message: string) => { send({ type: 'error', message }); return () => undefined; };
    const agentFile = resolveAgent(this.o.framework, String(input.agent || ''));
    if (!agentFile) return fail('agent inconnu');
    const message = String(input.message || '').trim();
    if (!message || message.length > MAX_MESSAGE_CHARS) return fail('message vide ou trop long');
    const sessionId = typeof input.sessionId === 'string' && SESSION_ID.test(input.sessionId) ? input.sessionId : null;
    if (this.running.size >= (this.o.maxConcurrent ?? 2)) return fail('déjà occupé, réessayez dans un instant');

    const args = chatArgs({
      agentFile, mcpConfig: this.mcpConfig, mcpNames: Object.keys(this.o.mcpServers), message, sessionId,
      model: this.o.model || 'sonnet', effort: this.o.effort || 'medium',
    });
    const env = { ...process.env };
    delete env.CLAUDE_CODE_CHILD_SESSION;
    env.CLAUDE_AGENT_NAME = path.basename(agentFile, '.md');
    const p = spawn(findClaude(), args, { cwd: this.o.framework, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.running.add(p);
    let finished = false;
    let stderr = '';
    const finish = (e: ChatEvent) => { if (finished) return; finished = true; send(e); };
    let buf = '';
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let j: Record<string, unknown>;
        try { j = JSON.parse(line); } catch { continue; }
        for (const e of eventsOf(j)) (e.type === 'done' || e.type === 'error' ? finish(e) : send(e));
      }
    });
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (d: string) => { stderr = (stderr + d).slice(-1000); });
    p.on('error', (err) => { this.running.delete(p); finish({ type: 'error', message: `claude introuvable : ${err.message}` }); });
    p.on('exit', (code) => {
      this.running.delete(p);
      finish(code === 0 ? { type: 'done', sessionId } : { type: 'error', message: stderr.trim().split(/\r?\n/).pop() || `claude a quitté (${code})` });
    });
    return () => { if (!finished) { finished = true; p.kill(); } };
  }
}

