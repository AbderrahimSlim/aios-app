/* JARVIS — the guard hook (PreToolUse / PostToolUse), the firewall that still applies in
   bypassPermissions mode.

     node guard.js pre    < hook JSON   → allow (exit 0, no output) or deny (permissionDecision: deny)
     node guard.js post   < hook JSON   → records that external content was just read (taint)

   Policy (config: <workspace>/guard.json, written by workspace.ts):
   - Writes (Write/Edit/NotebookEdit) only inside the allowed roots.
   - Shell commands are parsed into words, not matched as substrings: recursive deletes outside the
     roots (or of a root itself), force-push, disk/registry/shutdown tools, piping a download into a
     shell, and reading secrets are refused.
   - TAINT WINDOW (from jarvis-fr): for 5 minutes after the session read outside content (a web page,
     a search, an e-mail or chat MCP), shell commands and PC-node actions are refused, so a prompt
     injected in that content cannot act on the machine.
   Any failure to read the input or the config DENIES (fails closed). Kept dependency-free and quick:
   it runs before every tool call. */
import * as fs from 'node:fs';
import * as path from 'node:path';

const TAINT_MS = 5 * 60 * 1000;
const EXTERNAL = /^(WebFetch|WebSearch)$|^mcp__(google-workspace|slack|atlassian|forum|notebooklm|claude_ai_Gmail|claude_ai_)/;
const NODE_ACTION = /^mcp__aios-nodes__/;
const SHELL = /^(Bash|PowerShell)$/;
const SECRET = /(^|[\\/])(\.env(\..*)?|\.credentials\.json|credentials\.json|id_(rsa|ed25519)(\.pub)?|supervisor\.token|devices\.json|pairing-codes\.json|\.netrc|\.npmrc|\.git-credentials)$/i;

interface Guard { roots: string[]; stateFile: string; }

export function norm(p: string): string {
  let s = path.resolve(String(p).replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '~'));
  if (process.platform === 'win32') s = s.toLowerCase();
  return s.replace(/[\\/]+$/, '');
}
export function inside(p: string, roots: string[]): boolean {
  const n = norm(p);
  return roots.map(norm).some((r) => n === r || n.startsWith(r + path.sep));
}
export function isRoot(p: string, roots: string[]): boolean {
  const n = norm(p);
  return roots.map(norm).some((r) => n === r || r.startsWith(n + path.sep)) || /^[a-z]:$/i.test(n) || n === '/' || n === norm('~');
}

/** Shell words, respecting quotes. Good enough to find the commands and their arguments. */
export function words(cmd: string): string[][] {
  const out: string[][] = [[]];
  let cur = '', q: string | null = null;
  const push = () => { if (cur) { out[out.length - 1].push(cur); cur = ''; } };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')' || c === '`' || c === '$' && cmd[i + 1] === '(') {
      push();
      if (out[out.length - 1].length) out.push([]);
      if (c === '|') out[out.length - 1].push('|PIPE|');
      continue;
    }
    if (/\s/.test(c)) { push(); continue; }
    cur += c;
  }
  push();
  return out.filter((w) => w.length);
}

/* Commands that run another command: the guard judges the command inside, not the wrapper. */
const PASS_THROUGH = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'command', 'exec', 'xargs', 'nice', 'timeout', 'start-process', 'start', 'call', 'runas']);
const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'dash', 'wsl']);

/** The command a wrapper runs: `sudo rm …` → `rm …`; `cmd /c rd …` and `powershell -c "…"` → their inner text. */
export function unwrap(w: string[]): { words?: string[]; inner?: string } {
  let i = 0;
  for (let guard = 0; guard < 8 && i < w.length; guard++) {
    const exe = path.basename(w[i]).toLowerCase().replace(/\.exe$/, '');
    if (PASS_THROUGH.has(exe)) {
      i++;
      while (i < w.length && (/^-/.test(w[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || /^\d+[smhd]?$/.test(w[i]))) i++;   // flags, VAR=val, timeouts
      continue;
    }
    if (SHELLS.has(exe)) {
      const rest = w.slice(i + 1);
      const at = rest.findIndex((a) => /^([/-](c|k|command|encodedcommand|e|ec)|-lc|-ic)$/i.test(a));
      if (at >= 0) {
        if (/^-(encodedcommand|e|ec)$/i.test(rest[at])) return { inner: 'ENCODED_COMMAND_REFUSED' };
        return { inner: rest.slice(at + 1).join(' ') };
      }
      return { words: w.slice(i) };
    }
    break;
  }
  return { words: w.slice(i) };
}

/** Why a shell command is refused, or null. */
export function shellVerdict(cmd: string, roots: string[], depth = 0): string | null {
  if (depth > 3) return 'too many nested shells';
  if (cmd.includes('ENCODED_COMMAND_REFUSED')) return 'encoded PowerShell commands are not allowed';
  const segs = words(cmd);
  for (let k = 0; k < segs.length; k++) {
    const raw = segs[k].filter((x) => x !== '|PIPE|');
    if (!raw.length) continue;
    const u = unwrap(raw);
    if (u.inner !== undefined) { const v = shellVerdict(u.inner, roots, depth + 1); if (v) return v; continue; }
    const w = u.words || raw;
    if (!w.length) continue;
    const exe = path.basename(w[0]).toLowerCase().replace(/\.exe$/, '');
    const args = w.slice(1);
    const flags = args.filter((a) => /^-/.test(a)).join(' ').toLowerCase();
    /* cmd's own switches (rd /s /q) are options, not paths. */
    const cmdStyle = ['rd', 'rmdir', 'del', 'erase'].includes(exe);
    const paths = args.filter((a) => !/^-/.test(a) && !(cmdStyle && /^\/[a-z?]$/i.test(a)));
    if (['format', 'diskpart', 'shutdown', 'mkfs', 'dd', 'reg', 'bcdedit', 'cipher', 'vssadmin', 'takeown', 'icacls', 'net'].includes(exe)) return `${exe} is not allowed`;
    if (['stop-computer', 'restart-computer', 'format-volume', 'clear-disk', 'remove-partition'].includes(exe)) return `${w[0]} is not allowed`;
    const recursive = /(^|\s)-(\w*r\w*|recurse)\b/i.test(flags) || /(^|\s)--recursive\b/i.test(flags) || /(^|\s)\/s\b/i.test(args.join(' '));
    if ((exe === 'rm' || exe === 'remove-item' || exe === 'ri' || exe === 'rd' || exe === 'rmdir' || exe === 'del' || exe === 'erase') && (recursive || exe === 'rd' || exe === 'rmdir')) {
      if (!paths.length) return 'recursive delete without a path';
      for (const p of paths) if (/[*?]/.test(p) && isRoot(path.dirname(p), roots) || isRoot(p, roots) || !inside(p, roots)) return `recursive delete outside the allowed folders: ${p}`;
    }
    if (exe === 'git' && args[0] === 'push' && /(^|\s)(-f|--force|--force-with-lease|--mirror|--delete)\b/.test(' ' + args.join(' '))) return 'force-push or remote delete';
    if (exe === 'git' && args[0] === 'clean' && /-\w*f/.test(flags)) return 'git clean -f';
    if ((exe === 'curl' || exe === 'wget' || exe === 'invoke-webrequest' || exe === 'iwr' || exe === 'irm' || exe === 'invoke-restmethod') && segs[k + 1]?.[0] === '|PIPE|') {
      const next = path.basename(segs[k + 1][1] || '').toLowerCase();
      if (['sh', 'bash', 'zsh', 'iex', 'invoke-expression', 'powershell', 'pwsh', 'python', 'python3', 'node'].includes(next)) return 'piping a download into an interpreter';
    }
    if (exe === 'iex' || exe === 'invoke-expression') return 'Invoke-Expression is not allowed';
    if (['cat', 'type', 'get-content', 'gc', 'less', 'more', 'head', 'tail', 'cp', 'copy', 'copy-item', 'scp', 'curl'].includes(exe) && paths.some((p) => SECRET.test(p))) return 'reading or sending a secret file';
    if (exe === 'npm' && (args[0] === 'publish' || args[0] === 'unpublish')) return 'npm publish';
  }
  return null;
}

export function verdict(input: { tool_name?: string; tool_input?: Record<string, unknown> }, g: Guard, now = Date.now()): string | null {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  let tainted = false;
  try { tainted = now - Number(JSON.parse(fs.readFileSync(g.stateFile, 'utf8')).externalAt || 0) < TAINT_MS; } catch { tainted = false; }
  if (tainted && (SHELL.test(tool) || NODE_ACTION.test(tool))) return 'outside content was read less than 5 minutes ago: shell and PC actions are paused (anti prompt-injection)';
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const p = String(ti.file_path || ti.notebook_path || '');
    if (!p || !inside(p, g.roots)) return `writing outside the allowed folders: ${p}`;
    if (SECRET.test(p)) return 'writing a secret file';
  }
  if (tool === 'Read' && SECRET.test(String(ti.file_path || ''))) return 'reading a secret file';
  if (SHELL.test(tool)) return shellVerdict(String(ti.command || ''), g.roots);
  return null;
}

function main(): void {
  const mode = process.argv[2];
  const cfgFile = path.join(process.cwd(), 'guard.json');
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    const deny = (reason: string) => {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Jarvis guard: ${reason}` } }));
      process.exit(0);
    };
    let input: { tool_name?: string; tool_input?: Record<string, unknown> };
    let g: Guard;
    try { input = JSON.parse(raw); g = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) {
      if (mode === 'pre') deny(`guard could not read its input or config (${String(e)})`);
      process.exit(0);
    }
    if (mode === 'post') {
      if (EXTERNAL.test(String(input!.tool_name || ''))) {
        try { fs.writeFileSync(g!.stateFile, JSON.stringify({ externalAt: Date.now(), tool: input!.tool_name })); } catch { /* best effort */ }
      }
      process.exit(0);
    }
    const why = verdict(input!, g!);
    if (why) deny(why);
    process.exit(0);
  });
}

if (require.main === module) main();
