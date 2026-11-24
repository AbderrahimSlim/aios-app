/* HOST MODE — the phone app (a PWA installed from Safari, served at /m).

   Two pure helpers the gateway uses, kept here so they are testable without a socket:
   - where pairing may send the browser afterwards (a fixed list: never a URL taken from the request);
   - the Claude Code sessions running on the host, read from its session registry. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Pages pairing may return to. A fixed set, so `?next=` can never become an open redirect. */
const NEXT_ALLOWED = new Set(['/', '/m']);
export function safeNext(next: unknown): string {
  return typeof next === 'string' && NEXT_ALLOWED.has(next) ? next : '/';
}

/** The page's Content-Security-Policy may name the socket's own wss:// origin, built from the Host
    header — accepted only when it is a plain host[:port]. */
export function safeHost(host: unknown): string | null {
  return typeof host === 'string' && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? host : null;
}

/** `aliases`: the names the session had before a rename. A terminal is named once, at launch
    (`claude --name X`), and keeps that name, so the terminal is matched by name OR by one of these. */
export interface SessionRow { name: string; aliases: string[]; status: 'busy' | 'idle' | 'other'; folder: string; updatedAt: number; kind: string; entrypoint: string; sessionId: string; }

/** Where Claude Code keeps its session registry (one JSON per running session). */
export function sessionsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'sessions');
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Running sessions, most recently active first. A registry file whose process is gone is skipped:
    the registry outlives a crashed session. Read only; nothing in a row comes from outside the host. */
export function listSessions(dir: string = sessionsDir(), alive: (pid: number) => boolean = pidAlive): SessionRow[] {
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const rows: SessionRow[] = [];
  for (const f of files) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const pid = Number(j.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) continue;
    /* SDK sessions are programs, not conversations (Jarvis's own conductor is one): not listed. */
    if (String(j.entrypoint || '').startsWith('sdk')) continue;
    const former = Array.isArray(j.formerNames) ? j.formerNames : [];
    const aliases = former.map((x: unknown) => String((x as { name?: unknown })?.name || '')).filter(Boolean).slice(0, 10);
    const status = j.status === 'busy' ? 'busy' : j.status === 'idle' ? 'idle' : 'other';
    const cwd = typeof j.cwd === 'string' ? j.cwd : '';
    rows.push({
      name: String(j.name || j.sessionId || pid).slice(0, 120),
      aliases,
      status,
      folder: cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : '',
      updatedAt: Number(j.updatedAt) || Number(j.startedAt) || 0,
      kind: String(j.kind || ''),
      entrypoint: String(j.entrypoint || ''),
      /* The conversation's id: the phone's chat view follows its transcript (chatSkin:watch). */
      sessionId: /^[0-9a-f-]{36}$/i.test(String(j.sessionId || '')) ? String(j.sessionId) : '',
    });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
}
