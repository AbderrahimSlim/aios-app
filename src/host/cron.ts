/* A five-field cron expression (minute hour day-of-month month day-of-week), local time. Pure.
   Supports `*`, numbers, lists `a,b`, ranges `a-b`, steps `*\/n` and `a-b/n`; day-of-week 0-7 (0 and 7
   are Sunday). As in classic cron, when both day fields are restricted, either may match. */

type Field = Set<number>;
export interface Cron { min: Field; hour: Field; dom: Field; mon: Field; dow: Field; domAny: boolean; dowAny: boolean; }

function field(src: string, lo: number, hi: number): Field {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad cron field "${src}"`);
    const step = m[4] ? Number(m[4]) : 1;
    const a = m[1] === '*' ? lo : Number(m[2]);
    const b = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a;
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`cron value out of range in "${src}"`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  const dow = field(f[4], 0, 7);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { min: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31), mon: field(f[3], 1, 12), dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}

export function cronMatches(c: Cron, d: Date): boolean {
  if (!c.min.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate()), dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/** The next minute strictly after `from` that matches (searches up to a year). */
export function nextRun(c: Cron, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(c, d)) return d;
  }
  return null;
}
