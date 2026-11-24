/* aios-host MEMORY DISTILLER (plan phase 3): the vault learns from every Claude session, with nothing
   for the operator to approve.

   Every two minutes it looks at Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl). A session that
   has new content and has been idle for more than `idleMinutes` (default 15) — closed properly, killed,
   or simply left open — is distilled: its new exchanges (from the checkpoint on) are given to a one-shot
   Claude with NO tools and NO saved session, which returns the durable facts as JSON. They are appended
   to vault/00 - notes/context/observed/<file>.md and committed in the framework repository, one commit per
   session ("memory: …"), so any of them can be undone with `git revert`. Jarvis does that on "oublie ça".

   Never the past: on first start every existing transcript is checkpointed at its current end.
   Background work: it waits while the 5-hour quota is over the governor's threshold, runs one
   distillation at a time and at most `maxPerHour` per hour. */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findClaude } from '../jarvis/conductor';
import { activity, fiveHourPct } from './scheduler';

const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const CHECKPOINTS = path.join(os.homedir(), '.aios', 'memory-checkpoints.json');
const FILES = ['session-insights', 'preferences', 'patterns', 'business', 'growth'] as const;
const MAX_READ = 400 * 1024;
const MAX_PROMPT_CHARS = 40_000;

export interface DistillerOptions { framework: string; hostHome: string; idleMinutes: number; maxPerHour: number; maxFiveHourPct: number; }

/** The operator/assistant text of transcript lines (tool calls and results left out). */
export function exchanges(jsonl: string): string {
  const out: string[] = [];
  for (const line of jsonl.split('\n')) {
    let m: Record<string, any>;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.isSidechain || m.isMeta) continue;
    const c = m.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
    if (!text || /^<(command|local-command|system-reminder)/.test(text.trim())) continue;
    if (m.type === 'user') out.push(`OPÉRATEUR : ${text.trim()}`);
    else if (m.type === 'assistant') out.push(`CLAUDE : ${text.trim()}`);
  }
  return out.join('\n\n');
}

/** Parse the distiller's answer: {"facts":[{"file","text"}]} (tolerates text around the JSON). */
export function parseFacts(answer: string): Array<{ file: string; text: string }> {
  const m = /\{[\s\S]*\}/.exec(answer);
  if (!m) return [];
  try {
    const facts = JSON.parse(m[0]).facts;
    if (!Array.isArray(facts)) return [];
    return facts
      .filter((f: any) => f && typeof f.text === 'string' && f.text.trim().length > 8)
      .slice(0, 8)
      .map((f: any) => ({ file: (FILES as readonly string[]).includes(f.file) ? f.file : 'session-insights', text: f.text.replace(/\s+/g, ' ').trim().slice(0, 400) }));
  } catch { return []; }
}

function prompt(session: string, text: string, known: string): string {
  return `Tu tiens la mémoire d'un AIOS personnel. Voici les nouveaux échanges d'une session Claude (« ${session} »).

Extrais au plus 8 FAITS DURABLES sur l'opérateur qui serviront dans des semaines : décisions prises, préférences
de travail, projets et leur état, engagements et échéances, personnes et leur rôle. Pas le déroulé de la session,
pas de détail technique passager, pas de doublon de ce qui est déjà connu (ci-dessous).
INTERDIT : secrets, clés, mots de passe, jetons, données bancaires ; détails confidentiels d'un client au-delà du
nom du projet. Une phrase en français par fait, autonome (compréhensible sans la session).

Fichier de chaque fait : "preferences" (comment il aime travailler), "patterns" (habitudes observées),
"business" (activité, clients, chiffres non sensibles), "growth" (apprentissages), sinon "session-insights".

Réponds UNIQUEMENT avec ce JSON : {"facts":[{"file":"…","text":"…"}]} — {"facts":[]} s'il n'y a rien de durable.

<deja_connu>
${known}
</deja_connu>

<echanges>
${text}
</echanges>`;
}

export class Distiller {
  private cp: Record<string, number> = {};
  private running = false;
  private runs: number[] = [];
  private readonly observed: string;
  private readonly cwd: string;

  constructor(private readonly o: DistillerOptions) {
    this.observed = path.join(o.framework, 'vault', '00 - notes', 'context', 'observed');
    this.cwd = path.join(o.hostHome, 'distiller');
    try { this.cp = JSON.parse(fs.readFileSync(CHECKPOINTS, 'utf8')); } catch { this.cp = {}; }
  }

  private transcripts(): Array<{ file: string; size: number; mtime: number }> {
    const out: Array<{ file: string; size: number; mtime: number }> = [];
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(PROJECTS); } catch { return out; }
    for (const d of dirs) {
      if (/aios-host-(distiller|jarvis)$/i.test(d)) continue;          // its own one-shots; Jarvis is covered by its own notes
      let files: string[] = [];
      try { files = fs.readdirSync(path.join(PROJECTS, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        try { const st = fs.statSync(path.join(PROJECTS, d, f)); out.push({ file: path.join(PROJECTS, d, f), size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ }
      }
    }
    return out;
  }

  private save(): void {
    try { fs.mkdirSync(path.dirname(CHECKPOINTS), { recursive: true }); fs.writeFileSync(CHECKPOINTS, JSON.stringify(this.cp, null, 1)); } catch { /* best effort */ }
  }

  start(): void {
    fs.mkdirSync(this.cwd, { recursive: true });
    if (!fs.existsSync(CHECKPOINTS)) {
      for (const t of this.transcripts()) this.cp[t.file] = t.size;      // never distill the past
      this.save();
    }
    setInterval(() => { void this.tick(); }, 120_000).unref();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    const now = Date.now();
    this.runs = this.runs.filter((t) => now - t < 3600_000);
    if (this.runs.length >= this.o.maxPerHour) return;
    const pct = fiveHourPct();
    if (pct !== null && pct >= this.o.maxFiveHourPct) return;
    const due = this.transcripts()
      .filter((t) => t.size > (this.cp[t.file] ?? 0) && now - t.mtime > this.o.idleMinutes * 60_000)
      .sort((a, b) => a.mtime - b.mtime)[0];
    if (!due) return;
    this.running = true;
    try { await this.distill(due.file, due.size); } catch (e) { activity(this.o.hostHome, 'memory', `distillation échouée : ${String(e).slice(0, 200)}`); }
    finally { this.running = false; }
  }

  async distill(file: string, size: number): Promise<number> {
    const from = Math.max(this.cp[file] ?? 0, size - MAX_READ);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    let raw = buf.toString('utf8');
    if (from > 0) raw = raw.slice(raw.indexOf('\n') + 1);            // start on a whole line
    const text = exchanges(raw).slice(-MAX_PROMPT_CHARS);
    const done = () => { this.cp[file] = size; this.save(); };
    if (text.length < 300) { done(); return 0; }
    const label = this.sessionName(raw) || path.basename(file, '.jsonl').slice(0, 8);
    let known = '';
    try { known = fs.readFileSync(path.join(this.observed, 'session-insights.md'), 'utf8').slice(-4000); } catch { /* none yet */ }
    this.runs.push(Date.now());
    const answer = await this.ask(prompt(label, text, known));
    const facts = parseFacts(answer);
    if (!facts.length) { done(); activity(this.o.hostHome, 'memory', `session « ${label} » : rien de durable`); return 0; }
    const day = new Date().toISOString().slice(0, 10);
    const touched = new Set<string>();
    fs.mkdirSync(this.observed, { recursive: true });
    for (const f of facts) {
      const target = path.join(this.observed, `${f.file}.md`);
      if (!fs.existsSync(target)) fs.writeFileSync(target, `# ${f.file}\n\n`);
      fs.appendFileSync(target, `- ${day} — ${f.text} _(session ${label})_\n`);
      touched.add(target);
    }
    await this.commit([...touched], `memory: ${label} (${facts.length} fait${facts.length > 1 ? 's' : ''})`);
    done();
    activity(this.o.hostHome, 'memory', `${facts.length} fait(s) retenu(s) de la session « ${label} »`);
    return facts.length;
  }

  private sessionName(raw: string): string | null {
    const m = /"(?:agentName|customTitle|name)":"([^"]{1,60})"/.exec(raw);
    return m ? m[1] : null;
  }

  private ask(p: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--model', 'sonnet', '--effort', 'low', '--tools', '', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--output-format', 'text'];
      const env = { ...process.env };
      delete env.CLAUDE_CODE_CHILD_SESSION;
      /* A missing cwd makes spawn fail with a misleading ENOENT naming the executable. */
      fs.mkdirSync(this.cwd, { recursive: true });
      const c = spawn(findClaude(), args, { cwd: this.cwd, env, windowsHide: true });
      c.on('error', (e) => reject(e));           // never an unhandled 'error' that would take the host down
      let out = '', err = '';
      c.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
      c.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
      const timer = setTimeout(() => { c.kill(); reject(new Error('timeout')); }, 180_000);
      c.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`claude exited ${code}: ${err.slice(-300)}`)); });
      c.stdin.end(p);
    });
  }

  /** One commit with ONLY these files (`git commit -- <paths>`), whatever else is staged or dirty. */
  private commit(files: string[], message: string): Promise<void> {
    return new Promise((resolve) => {
      const rel = files.map((f) => path.relative(this.o.framework, f));
      const git = (args: string[], cb: (e: Error | null) => void) => execFile('git', ['-c', 'user.name=AIOS memory', '-c', 'user.email=memory@aios.local', '-C', this.o.framework, ...args], { windowsHide: true }, (e) => cb(e));
      git(['add', '--', ...rel], () => git(['commit', '-q', '-m', message, '--', ...rel], (e) => {
        if (e) activity(this.o.hostHome, 'memory', `commit mémoire impossible : ${String(e.message).slice(0, 160)}`);
        resolve();
      }));
    });
  }
}
