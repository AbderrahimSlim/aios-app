/* JARVIS — turning a streamed reply into speech (pure; no I/O).

   Claude writes for a screen; a voice must not read markdown, code or links. `Speaker` takes text
   deltas as they stream and releases speakable chunks as soon as a sentence (or a long clause) is
   complete, so speech starts while Claude is still writing. Code blocks are skipped entirely and
   replaced by one short spoken note; inline code, emphasis, headings and link targets are reduced
   to their words. */

const SENTENCE_END = /([.!?…:;]["»”)]*)(\s+|$)/;
const MAX_CHUNK = 220;   // a clause that runs on is cut at a comma or a space rather than held back

/** Markdown → plain spoken words (for a complete chunk). */
export function speakable(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                 // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                  // links → their text
    .replace(/https?:\/\/\S+/g, 'un lien')                     // bare URLs are not read out
    .replace(/`([^`]+)`/g, '$1')                              // inline code → its text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                       // headings
    .replace(/^\s*[-*+]\s+/gm, '')                            // bullets
    .replace(/^\s*\d+\.\s+/gm, '')                            // numbered items
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2')    // emphasis
    .replace(/\|/g, ' ')                                       // table pipes
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

export class Speaker {
  private buf = '';
  private inFence = false;
  private fenceNoted = false;

  /** Feed a text delta; returns the chunks now ready to be spoken (possibly none). */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      if (this.inFence) {
        const end = this.buf.indexOf('```');
        if (end < 0) { this.buf = this.buf.slice(-2); return out; }   // keep a possible partial fence marker
        this.buf = this.buf.slice(end + 3);   // the language tag followed the OPENING fence, already skipped with the code
        this.inFence = false;
        continue;
      }
      const fence = this.buf.indexOf('```');
      const head = fence >= 0 ? this.buf.slice(0, fence) : this.buf;
      const chunk = this.takeSentence(head, fence >= 0);
      if (chunk !== null) {
        this.buf = this.buf.slice(chunk.length);
        const s = speakable(chunk);
        if (s) out.push(s);
        continue;
      }
      if (fence >= 0) {
        const before = speakable(this.buf.slice(0, fence));
        if (before) out.push(before);
        if (!this.fenceNoted) { out.push('Je mets le code à l’écran.'); this.fenceNoted = true; }
        this.buf = this.buf.slice(fence + 3);
        this.inFence = true;
        continue;
      }
      return out;
    }
  }

  /** Whatever is left at the end of the turn. */
  flush(): string[] {
    const rest = this.inFence ? '' : speakable(this.buf);
    this.buf = ''; this.inFence = false; this.fenceNoted = false;
    return rest ? [rest] : [];
  }

  private takeSentence(text: string, hardStop: boolean): string | null {
    const m = SENTENCE_END.exec(text);
    if (m && (m[2] || hardStop || m.index + m[1].length < text.length)) return text.slice(0, m.index + m[0].length);
    if (text.length > MAX_CHUNK) {
      const cut = Math.max(text.lastIndexOf(', ', MAX_CHUNK), text.lastIndexOf(' ', MAX_CHUNK));
      if (cut > 40) return text.slice(0, cut + 1);
    }
    return null;
  }
}

/** One short line for the activity feed, from a tool call (never spoken in full). */
export function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  const i = input || {};
  const pick = (k: string) => (typeof i[k] === 'string' ? String(i[k]) : '');
  const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  switch (name) {
    case 'Read': return `lit ${short(pick('file_path'))}`;
    case 'Write': return `écrit ${short(pick('file_path'))}`;
    case 'Edit': return `modifie ${short(pick('file_path'))}`;
    case 'Bash': case 'PowerShell': return `exécute ${short(pick('command'))}`;
    case 'Grep': return `cherche « ${short(pick('pattern'), 40)} »`;
    case 'Glob': return `liste ${short(pick('pattern'))}`;
    case 'WebSearch': return `recherche web « ${short(pick('query'), 50)} »`;
    case 'WebFetch': return `ouvre ${short(pick('url'))}`;
    case 'Task': case 'Agent': return `délègue : ${short(pick('description'))}`;
    default: return short(name.replace(/^mcp__/, '').replace(/__/g, ' › '));
  }
}
