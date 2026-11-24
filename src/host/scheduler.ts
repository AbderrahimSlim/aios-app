/* aios-host SCHEDULER and GOVERNOR (plan phase 3; docs/rfcs/cloud-mode.md §5.1 "Scheduler").

   Routines are notes in the vault, so the operator edits them in Obsidian:

     vault/00 - notes/routines/<slug>.md
     ---
     schedule: "0 8 * * 1-5"      # cron, local time
     enabled: true
     via: agent                   # agent: a session `routine-<slug>` through the spawn inbox (default)
                                  # jarvis: asked to Jarvis, whose answer is spoken on the active device
     agent: accountant            # optional hat; tier / effort optional too
     ---
     The task, in plain words.

   GOVERNOR — background work must never starve the operator's own use of Claude:
   - no run while the account's 5-hour usage is at or above `maxFiveHourPct` (default 70 %),
     read from Claude Code's status-line cache; a deferred run is retried every minute for two hours;
   - at most `maxConcurrent` routine sessions at once (default 2);
   - never two runs of the same routine at once.
   Each routine reports to ~/.aios/health/routine-<slug>.json (the contract the Health card reads),
   and every run, deferral and skip is appended to ~/.aios/host/activity.jsonl. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cron, cronMatches, nextRun, parseCron } from './cron';

export interface Governor { maxFiveHourPct: number; maxConcurrent: number; }
export interface Routine { slug: string; file: string; cron: Cron; schedule: string; enabled: boolean; via: 'agent' | 'jarvis'; agent?: string; tier?: string; effort?: string; task: string; }
export interface SchedulerDeps {
  framework: string;
  hostHome: string;
  isLive: (name: string) => boolean;
  liveCount: (prefix: string) => number;
  askJarvis?: (text: string) => void;
}

/** The spawn inbox the command bus watches (main/commandBus inboxDir: always ~/.aios/spawn-inbox). */
export const INBOX = path.join(os.homedir(), '.aios', 'spawn-inbox');
const HEALTH = path.join(os.homedir(), '.aios', 'health');
const DEFER_LIMIT_MS = 2 * 60 * 60 * 1000;

export function activity(hostHome: string, kind: string, text: string): void {
  try { fs.appendFileSync(path.join(hostHome, 'activity.jsonl'), JSON.stringify({ at: Date.now(), kind, text }) + '\n'); } catch { /* best effort */ }
}

export function readActivity(hostHome: string, since: number): Array<{ at: number; kind: string; text: string }> {
  try {
    return fs.readFileSync(path.join(hostHome, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e): e is { at: number; kind: string; text: string } => !!e && e.at > since);
  } catch { return []; }
}

/** Claude Code's last status-line numbers (written by the AIOS status line), or null when unknown. */
export function fiveHourPct(): number | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'rate-limit-cache.json'), 'utf8'));
    const v = Number(d.five_hour_pct);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** Minimal frontmatter reader: `key: value` lines between the first two `---`. */
export function parseRoutine(file: string, text: string): Routine | { error: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { error: 'no frontmatter' };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '');
  }
  if (!fm.schedule) return { error: 'no schedule' };
  let cron: Cron;
  try { cron = parseCron(fm.schedule); } catch (e) { return { error: String((e as Error).message) }; }
  const slug = path.basename(file, '.md').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const task = m[2].trim();
  if (!task) return { error: 'empty task' };
  return {
    slug, file, cron, schedule: fm.schedule, enabled: !/^(false|no|0|off)$/i.test(fm.enabled || 'true'),
    via: fm.via === 'jarvis' ? 'jarvis' : 'agent', agent: fm.agent || undefined, tier: fm.tier || undefined, effort: fm.effort || undefined, task,
  };
}

function iso(ms: number): string { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

export class Scheduler {
  private readonly dir: string;
  private readonly deferred = new Map<string, number>();    // slug → first due time
  /** Runs written to the inbox whose session is not live YET (the bus takes a moment): slug → when. */
  private readonly launched = new Map<string, number>();
  private static readonly LAUNCH_GRACE_MS = 3 * 60 * 1000;

  /** Launched recently and not yet visible as a live session. */
  private pending(): string[] {
    const now = Date.now();
    for (const [slug, at] of this.launched) {
      if (now - at > Scheduler.LAUNCH_GRACE_MS || this.d.isLive(`routine-${slug}`)) this.launched.delete(slug);
    }
    return [...this.launched.keys()];
  }
  private lastTick = 0;
  private gov: Governor = { maxFiveHourPct: 70, maxConcurrent: 2 };

  constructor(private readonly d: SchedulerDeps) {
    this.dir = path.join(d.framework, 'vault', '00 - notes', 'routines');
  }

  private loadGovernor(): void {
    try { this.gov = { ...this.gov, ...JSON.parse(fs.readFileSync(path.join(this.d.hostHome, 'governor.json'), 'utf8').replace(/^\uFEFF/, '')) }; } catch { /* defaults */ }
  }

  routines(): Array<Routine | { file: string; error: string }> {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.md') && !n.startsWith('_')); } catch { return []; }
    return names.map((n) => {
      const file = path.join(this.dir, n);
      try { const r = parseRoutine(file, fs.readFileSync(file, 'utf8')); return 'error' in r ? { file, error: r.error } : r; }
      catch (e) { return { file, error: String(e) }; }
    });
  }

  /** Why background work may not start now, or null. */
  blocked(): string | null {
    this.loadGovernor();
    const pct = fiveHourPct();
    if (pct !== null && pct >= this.gov.maxFiveHourPct) return `quota 5 h à ${pct} % (seuil ${this.gov.maxFiveHourPct} %)`;
    if (this.d.liveCount('routine-') + this.pending().length >= this.gov.maxConcurrent) return `${this.gov.maxConcurrent} routines déjà en cours`;
    return null;
  }

  start(): void {
    setInterval(() => this.tick(new Date()), 15_000).unref();
    this.tick(new Date());
  }

  tick(now: Date): void {
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === this.lastTick) return;
    this.lastTick = minute;
    for (const r of this.routines()) {
      if ('error' in r) { this.health(path.basename(r.file, '.md'), 'fail', `routine illisible : ${r.error}`, Date.now() + 24 * 3600_000); continue; }
      if (!r.enabled) continue;
      const due = cronMatches(r.cron, now);
      if (due && !this.deferred.has(r.slug)) this.deferred.set(r.slug, now.getTime());
      const since = this.deferred.get(r.slug);
      if (since === undefined) {
        /* Keep the health file valid between runs, so an idle routine never reads as overdue. */
        const n = nextRun(r.cron, now);
        const hf = path.join(HEALTH, `routine-${r.slug}.json`);
        if (n && !fs.existsSync(hf)) this.health(r.slug, 'pending', `prochaine exécution ${n.toLocaleString('fr-FR')}`, n.getTime() + 3600_000);
        continue;
      }
      if (now.getTime() - since > DEFER_LIMIT_MS) {
        this.deferred.delete(r.slug);
        activity(this.d.hostHome, 'routine', `« ${r.slug} » sautée : bloquée plus de 2 h`);
        this.next(r, now, 'warn', 'sautée : bloquée plus de 2 h par le régulateur');
        continue;
      }
      if (this.d.isLive(`routine-${r.slug}`) || this.pending().includes(r.slug)) {
        if (due) activity(this.d.hostHome, 'routine', `« ${r.slug} » : exécution précédente encore en cours`);
        continue;
      }
      const why = r.via === 'agent' ? this.blocked() : null;
      if (why) { if (due) activity(this.d.hostHome, 'routine', `« ${r.slug} » reportée : ${why}`); continue; }
      this.deferred.delete(r.slug);
      this.run(r, now);
    }
  }

  private run(r: Routine, now: Date): void {
    if (r.via === 'jarvis') {
      if (!this.d.askJarvis) { this.next(r, now, 'fail', 'Jarvis n’est pas démarré'); return; }
      this.d.askJarvis(`[Routine « ${r.slug} »] ${r.task}`);
      activity(this.d.hostHome, 'routine', `« ${r.slug} » demandée à Jarvis`);
      this.next(r, now, 'ok', `demandée à Jarvis le ${now.toLocaleString('fr-FR')}`);
      return;
    }
    const req: Record<string, unknown> = { name: `routine-${r.slug}`, task: `${r.agent ? `Mets le hat ${r.agent}. ` : ''}${r.task}\n\nC'est une routine planifiée : fais le travail, écris le résultat dans le vault, puis termine.` };
    if (r.tier) req.tier = r.tier;
    if (r.effort) req.effort = r.effort;
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    try {
      fs.mkdirSync(INBOX, { recursive: true });
      const tmp = path.join(INBOX, `.${stamp}-routine-${r.slug}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(req, null, 2));
      fs.renameSync(tmp, path.join(INBOX, `${stamp}-routine-${r.slug}.json`));
      this.launched.set(r.slug, Date.now());
      activity(this.d.hostHome, 'routine', `« ${r.slug} » lancée (session routine-${r.slug})`);
      this.next(r, now, 'ok', `lancée le ${now.toLocaleString('fr-FR')}`);
    } catch (e) { this.next(r, now, 'fail', `inbox : ${String(e)}`); }
  }

  private next(r: Routine, now: Date, state: 'ok' | 'warn' | 'fail', detail: string): void {
    const n = nextRun(r.cron, now);
    this.health(r.slug, state, detail, (n ? n.getTime() : now.getTime() + 24 * 3600_000) + 3600_000);
  }

  private health(slug: string, state: string, detail: string, validUntil: number): void {
    try {
      fs.mkdirSync(HEALTH, { recursive: true });
      const now = Date.now();
      fs.writeFileSync(path.join(HEALTH, `routine-${slug}.json`), JSON.stringify({ name: `routine-${slug}`, state, detail, written_at: iso(now), valid_until: iso(Math.max(validUntil, now + 60_000)) }, null, 2));
    } catch { /* best effort */ }
  }
}
