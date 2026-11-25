/**
 * The phone app (/m): what renderer/web/mobile.js and web-shell.js do, run for real in a small fake page.
 *
 * mobile.js is loaded whole into a vm with a minimal DOM, a fake host (ipc) and a hand-driven clock, then
 * driven the way a finger does: a shortcut, the send form, a dialog button, a socket that comes back. What
 * the host receives is what is asserted: these are the checks that previously had no test (explainer of
 * 1136341, section 4) plus the reconnect and "envoi…" behaviour of 2c6eec6.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── a hand-driven clock ─────────────────────────────────────────────────────────────────────────
function clock() {
  let now = 0, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number }>();
  const set = (fn: () => void, ms = 0, every = 0) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn, every }); return id; };
  return {
    get now() { return now; },
    setTimeout: (fn: () => void, ms?: number) => set(fn, ms),
    setInterval: (fn: () => void, ms?: number) => set(fn, ms, Math.max(1, ms || 1)),
    clear: (id: number) => { timers.delete(id); },
    /** Run every timer due within `ms`, in time order, letting promises settle between them. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        let next: [number, { at: number; fn: () => void; every: number }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e;
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at = now + t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
      await flush();
    },
  };
}
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

// ── a minimal DOM ───────────────────────────────────────────────────────────────────────────────
class El {
  tagName: string; parent: El | null = null; children: El[] = [];
  className = ''; hidden = false; value = ''; type = ''; disabled = false; placeholder = ''; open = false;
  href = ''; target = ''; rel = ''; checked = false; innerHTML = ''; scrollTop = 0; scrollHeight = 0; clientHeight = 0;
  dataset: Record<string, string> = {}; style: Record<string, string> = {};
  private text = ''; private attrs: Record<string, string> = {}; private on: Record<string, Array<(e: any) => void>> = {};
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.detachAll(); this.text = String(v); }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      add: (...cs: string[]) => { this.className = [...new Set([...list(), ...cs])].join(' '); },
      remove: (...cs: string[]) => { this.className = list().filter((x) => !cs.includes(x)).join(' '); },
      toggle: (c: string, force?: boolean) => { const has = list().includes(c); const want = force === undefined ? !has : force; if (want && !has) this.classList.add(c); if (!want && has) this.classList.remove(c); return want; },
    };
  }
  private detachAll() { for (const c of this.children) c.parent = null; this.children = []; }
  private take(nodes: Array<El | string>): El[] {
    const out: El[] = [];
    for (const n of nodes) {
      if (typeof n === 'string') { const t = new El('#text'); t.text = n; out.push(t); continue; }
      if (n.tagName === '#FRAGMENT') { out.push(...n.children); n.children = []; continue; }
      out.push(n);
    }
    for (const n of out) { if (n.parent) n.remove(); n.parent = this; }
    return out;
  }
  append(...nodes: Array<El | string>) { this.children.push(...this.take(nodes)); }
  appendChild(n: El) { this.append(n); return n; }
  prepend(...nodes: Array<El | string>) { this.children.unshift(...this.take(nodes)); }
  replaceChildren(...nodes: Array<El | string>) { const keep = this.take(nodes); this.detachAll(); this.text = ''; for (const n of keep) n.parent = this; this.children = keep; }
  insertBefore(n: El, ref: El) { const [m] = this.take([n]); const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, m); }
  remove() { if (!this.parent) return; const p = this.parent; p.children = p.children.filter((c) => c !== this); this.parent = null; }
  replaceWith(n: El) { const p = this.parent; if (!p) return; const i = p.children.indexOf(this); this.remove(); p.insertBefore(n, p.children[i]); }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get nextElementSibling(): El | null { if (!this.parent) return null; const s = this.parent.children; return s[s.indexOf(this) + 1] || null; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener(type: string, fn: (e: any) => void) { (this.on[type] ||= []).push(fn); }
  dispatch(type: string, e: any = {}) { for (const fn of this.on[type] || []) fn({ preventDefault() { /* */ }, target: this, ...e }); }
  click() { this.dispatch('click'); }
  focus() { /* */ }
  requestSubmit() { this.dispatch('submit'); }
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
  /** Descendants carrying every class of a pure class selector (".a.b"); anything else matches nothing. */
  querySelectorAll(sel: string): El[] {
    if (!/^(\.[\w-]+)+$/.test(sel)) return [];
    const want = sel.slice(1).split('.');
    const out: El[] = [];
    const walk = (n: El) => { for (const c of n.children) { if (want.every((w) => c.classList.contains(w))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

/** Arguments copied out of the vm: its objects carry another realm's Object, which deepStrictEqual rejects. */
const realm = (a: unknown[]): any[] => JSON.parse(JSON.stringify(a));

// ── fake xterm ──────────────────────────────────────────────────────────────────────────────────
class FakeTerminal {
  cols: number; rows: number; written = ''; buffer = { active: { length: 0, getLine: () => null } };
  constructor(o: { cols: number; rows: number }) { this.cols = o.cols; this.rows = o.rows; }
  open() { /* */ } loadAddon() { /* */ } scrollLines() { /* */ } onWriteParsed() { /* */ }
  resize(c: number, r: number) { this.cols = c; this.rows = r; }
  write(d: string) { this.written += d; }
}

// ── the page: mobile.js against a fake host ─────────────────────────────────────────────────────
type Handler = (...a: any[]) => unknown;
function page(host: Record<string, Handler>, platform = 'win32') {
  const t = clock();
  const ids = new Map<string, El>();
  const body = new El('body');
  const acts = ['primary', 'resume', 'today', 'close-session', 'close-day', 'tasks', 'agent', 'skill', 'command', 'ingest', 'session']
    .map((a) => { const b = new El('button'); b.dataset.act = a; return b; });
  const document = {
    body, visibilityState: 'visible',
    getElementById: (id: string) => { if (!ids.has(id)) { const e = new El('div'); ids.set(id, e); body.append(e); } return ids.get(id)!; },
    createElement: (tag: string) => new El(tag),
    createDocumentFragment: () => new El('#fragment'),
    querySelectorAll: (sel: string) => (sel === '[data-act]' ? acts : []),
    addEventListener: () => { /* */ },
  };
  const calls: Array<{ kind: 'invoke' | 'send'; ch: string; a: any[]; at: number }> = [];
  const listeners = new Map<string, Array<(...a: any[]) => void>>();
  const ipc = {
    invoke: async (ch: string, ...a: any[]) => { calls.push({ kind: 'invoke', ch, a: realm(a), at: t.now }); const h = host[ch]; if (!h) throw new Error('no handler ' + ch); return h(...a); },
    send: (ch: string, ...a: any[]) => { calls.push({ kind: 'send', ch, a: realm(a), at: t.now }); },
    on: (ch: string, fn: (...a: any[]) => void) => { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch)!.push(fn); },
  };
  const window: any = {
    __aiosIpc: ipc, __AIOS_HOST__: { platform },
    glassShell: { shellConfig: async () => ({ claudeCmd: 'claude', primary: 'aios' }) },
    Terminal: FakeTerminal,
    addEventListener: () => { /* */ },
  };
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
  const ctx = vm.createContext({
    window, document, localStorage: store(), sessionStorage: store(), console,
    setTimeout: t.setTimeout, clearTimeout: t.clear, setInterval: t.setInterval, clearInterval: t.clear,
    requestAnimationFrame: (fn: () => void) => t.setTimeout(fn, 16), cancelAnimationFrame: t.clear,
    performance: { now: () => t.now },
  });
  vm.runInContext(fs.readFileSync('renderer/web/mobile.js', 'utf8'), ctx, { filename: 'mobile.js' });
  const $ = (id: string) => document.getElementById(id);
  return {
    t, $, calls,
    of: (ch: string) => calls.filter((c) => c.ch === ch),
    writes: () => calls.filter((c) => c.ch === 'pty:write').map((c) => c.a[0]),
    emit: async (ch: string, ...a: any[]) => { for (const fn of listeners.get(ch) || []) fn({ sender: null }, ...a); await flush(); },
    act: async (name: string) => { acts.find((b) => b.dataset.act === name)!.click(); await flush(); },
    chatBox: () => $('m-chat-list').children[0],
  };
}

/** A host with one free terminal per spawn, Claude Code's registry as given, chat watches accepted. */
function host(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'host:ptys': () => [], 'host:sessions': () => [], 'pty:spawn': () => 7, 'pty:run': () => true,
    'chatSkin:watch': () => ({ ok: true }), 'chatSkin:unwatch': () => true, 'aios:lists': () => ({ agents: [], skills: [], commands: [], suggestions: [] }),
    ...over,
  };
}

test('mobile.js loads in the fake page (control: the harness runs the real file)', async () => {
  const p = page(host());
  assert.equal(p.$('m-title').textContent, 'Jarvis');
  await flush();
  assert.equal(p.$('m-primary-label').textContent, 'Lancer aios', 'from the host config');
});

// ── launching ───────────────────────────────────────────────────────────────────────────────────
test('a shortcut launches the cockpit\'s own command in a host terminal and types it once, 500 ms later', async () => {
  const p = page(host());
  await p.act('close-session');
  const [spawn] = p.of('pty:spawn');
  assert.deepEqual(spawn.a[0], { cols: 100, rows: 40, cmd: "claude --name close-session '/aios:close-session'", name: 'close-session' });
  assert.equal(p.of('pty:run').length, 0, 'not before the terminal is sized');
  await p.t.advance(499);
  assert.equal(p.of('pty:run').length, 0);
  await p.t.advance(1);
  assert.deepEqual(p.of('pty:run')[0].a[0], { id: 7, cmd: "claude --name close-session '/aios:close-session'" });
});

test('a named session: the name becomes a handle, the task is quoted for PowerShell on Windows and for sh elsewhere', async () => {
  for (const [platform, quoted] of [['win32', "'l''audit du jour'"], ['linux', "'l'\\''audit du jour'"]]) {
    const p = page(host(), platform);
    await p.act('session');
    p.$('m-sheet-text').value = "l'audit du jour";
    p.$('m-sheet-name').value = ' Mon Audit ';
    p.$('m-picker-sheet').dispatch('submit');
    await flush();
    assert.equal(p.of('pty:spawn')[0].a[0].cmd, `claude --name mon-audit ${quoted}`, platform);
  }
  const p = page(host());
  await p.act('session');
  p.$('m-sheet-name').value = '!!!';
  p.$('m-picker-sheet').dispatch('submit');
  await flush();
  assert.equal(p.of('pty:spawn').length, 0, 'a name with nothing usable launches nothing');
  assert.equal(p.$('m-toast').textContent, 'Donne un nom à la session.');
});

test('a terminal held by another page is not opened a second time; a free one is taken back', async () => {
  const held = page(host({ 'host:ptys': () => [{ id: 3, name: 'close-session', attached: true, mine: false }] }));
  await held.act('close-session');
  assert.equal(held.of('pty:spawn').length, 0, 'no second session under the same name');
  assert.match(held.$('m-toast').textContent, /ouverte sur un autre appareil/);

  // control: the same terminal, free → opened (the host adopts it by name)
  const free = page(host({ 'host:ptys': () => [{ id: 3, name: 'close-session', attached: false, mine: false }] }));
  await free.act('close-session');
  assert.equal(free.of('pty:spawn').length, 1);
});

// ── chat: finding the conversation ──────────────────────────────────────────────────────────────
test('the chat follows the conversation found by the terminal\'s name, or by a name the session had before a rename', async () => {
  const p = page(host({ 'host:sessions': () => [{ name: 'Version mobile', aliases: ['other', 'today'], sessionId: 'sid-1', status: 'idle' }] }));
  await p.act('today');
  assert.deepEqual(p.of('chatSkin:watch').map((c) => c.a), [[7, null], [7, 'sid-1']], 'dialogs first, then the transcript');

  // control: nothing in the registry by that name → only the dialogs, and the registry is asked again 2 s later
  const q = page(host({ 'host:sessions': () => [{ name: 'someone-else', aliases: [], sessionId: 'sid-9', status: 'busy' }] }));
  await q.act('today');
  assert.deepEqual(q.of('chatSkin:watch').map((c) => c.a), [[7, null]]);
  const asked = q.of('host:sessions').length;
  await q.t.advance(2000);
  assert.equal(q.of('host:sessions').length, asked + 1);
});

// ── chat: sending ───────────────────────────────────────────────────────────────────────────────
test('a message is pasted whole, then submitted 250 ms later, and shows as "envoi…" until the transcript has it', async () => {
  const p = page(host());
  await p.act('today');
  p.$('m-send-text').value = 'bonjour\nla suite';
  p.$('m-send').dispatch('submit');
  assert.deepEqual(p.writes(), [{ id: 7, data: '\x1b[200~bonjour\nla suite\x1b[201~' }], 'one bracketed paste, no Enter yet');
  await p.t.advance(249);
  assert.equal(p.writes().length, 1);
  await p.t.advance(1);
  assert.deepEqual(p.writes()[1], { id: 7, data: '\r' });

  const box = p.chatBox();
  assert.equal(box.children.length, 1);
  assert.ok(box.children[0].classList.contains('m-pending'));
  // a line read from the transcript meanwhile goes ABOVE what is still being sent
  await p.emit('chatSkin:event', { paneId: 7, type: 'items', items: [{ uuid: 'a1', role: 'assistant', text: 'avant' }] });
  assert.deepEqual(box.children.map((c) => c.classList.contains('m-pending')), [false, true]);
  // the transcript's own line (whitespace differs) replaces it
  await p.emit('chatSkin:event', { paneId: 7, type: 'items', items: [{ uuid: 'u1', role: 'user', text: 'bonjour  la suite' }] });
  assert.equal(box.querySelectorAll('.m-pending').length, 0);
  assert.equal(box.children.filter((c) => c.classList.contains('m-msg-me')).length, 1, 'shown once, not twice');
});

test('a message the session never sees is marked after a minute, never left silent', async () => {
  const p = page(host());
  await p.act('today');
  p.$('m-send-text').value = 'perdu ?';
  p.$('m-send').dispatch('submit');
  const [node] = p.chatBox().children;
  await p.t.advance(59_999);
  assert.ok(!node.classList.contains('m-unsent'));
  await p.t.advance(1);
  assert.ok(node.classList.contains('m-unsent'));

  // control: an empty message sends nothing in chat mode
  const before = p.writes().length;
  p.$('m-send-text').value = '   ';
  p.$('m-send').dispatch('submit');
  await p.t.advance(300);
  assert.equal(p.writes().length, before);
});

test('while Claude waits on a question with options, a typed message is held back', async () => {
  const p = page(host());
  await p.act('today');
  await p.emit('chatSkin:event', { paneId: 7, type: 'prompt', kind: 'select', question: 'On continue ?', options: [{ n: 1, label: 'Oui', key: '\r' }] });
  p.$('m-send-text').value = 'autre chose';
  p.$('m-send').dispatch('submit');
  await p.t.advance(300);
  assert.equal(p.writes().length, 0);
  assert.match(p.$('m-toast').textContent, /attend d’abord ta réponse/);
});

// ── chat: dialog buttons ────────────────────────────────────────────────────────────────────────
test('a dialog option writes only arrows, Enter and digits, one key every 60 ms', async () => {
  const p = page(host());
  await p.act('today');
  await p.emit('chatSkin:event', { paneId: 7, type: 'prompt', kind: 'select', question: 'Q ?', options: [
    { n: 1, label: 'Oui', key: '\r' },
    { n: 2, label: 'Non', key: '\x1b[B\x1b[B\r' },
    { n: 3, label: 'Piège', key: 'rm -rf ~\r' },
    { n: 4, label: 'Échap', key: '\x1b' },
  ] });
  const opts = () => p.$('m-prompt-opts').children;
  assert.equal(opts().length, 4);
  opts()[2].click(); opts()[3].click();
  await p.t.advance(500);
  assert.equal(p.writes().length, 0, 'text and a bare Escape are refused');
  assert.equal(opts()[1].disabled, false, 'a refused key does not use up the question');

  opts()[1].click();
  await p.t.advance(500);
  const w = p.calls.filter((c) => c.ch === 'pty:write');
  assert.deepEqual(w.map((c) => c.a[0].data), ['\x1b[B', '\x1b[B', '\r']);
  assert.deepEqual(w.map((c) => c.at - w[0].at), [0, 60, 120]);
  assert.ok(opts().every((b) => b.disabled), 'answered: the buttons are spent');
});

// ── 2c6eec6: the socket comes back after the page was hidden ────────────────────────────────────
test('after a reconnect, an open terminal is taken back by name (never a second one) and its conversation followed again', async () => {
  let spawnId = 7;
  const h = host({ 'host:sessions': () => [{ name: 'today', aliases: [], sessionId: 'sid-1', status: 'busy' }], 'pty:spawn': () => spawnId });
  const p = page(h);
  await p.act('today');
  await p.t.advance(600);                           // the launch's own pty:run
  p.calls.length = 0;
  h['host:ptys'] = () => [{ id: 7, name: 'today', attached: false, mine: false }];   // the old socket's hold was released
  await p.emit('host:reconnected');
  const [spawn] = p.of('pty:spawn');
  assert.deepEqual(spawn.a[0], { cols: 100, rows: 40, name: 'today' }, 'taken back by name, with no command');
  assert.deepEqual(p.of('chatSkin:watch').map((c) => c.a), [[7, null], [7, 'sid-1']]);
  await p.t.advance(1000);
  assert.equal(p.of('pty:run').length, 0, 'nothing is typed into the live session');

  // the host handed back another id: events for it reach the same view
  p.calls.length = 0; spawnId = 9;
  h['host:ptys'] = () => [{ id: 7, name: 'today', attached: false, mine: false }];
  await p.emit('host:reconnected');
  await p.emit('chatSkin:event', { paneId: 9, type: 'items', items: [{ uuid: 'z', role: 'assistant', text: 'de retour' }] });
  assert.ok(p.chatBox().textContent.includes('de retour'));
});

test('after a reconnect, a terminal another device took meanwhile is reported, and one that ended is shown ended', async () => {
  const h = host();
  const p = page(h);
  await p.act('today');
  p.calls.length = 0;
  h['host:ptys'] = () => [{ id: 7, name: 'today', attached: true, mine: false }];
  await p.emit('host:reconnected');
  assert.equal(p.of('pty:spawn').length, 0);
  assert.match(p.$('m-chat-state').textContent, /ouverte sur un autre appareil/);

  const q = page(host());
  await q.act('today');
  q.calls.length = 0;
  await q.emit('host:reconnected');                 // host:ptys → [] : the terminal is gone
  assert.equal(q.of('pty:spawn').length, 0);
  assert.equal(q.$('m-session-state').textContent, 'Session terminée');
  assert.equal(q.of('chatSkin:unwatch').length, 1);
});

// ── 2c6eec6: web-shell tells the page, and reopens at once when it comes back in front ──────────
function shell() {
  const t = clock();
  const sockets: any[] = [];
  class FakeWS {
    static OPEN = 1; static CLOSED = 3;
    readyState = 0; sent: any[] = []; onopen: any; onmessage: any; onclose: any;
    constructor(public url: string) { sockets.push(this); }
    send(m: string) { this.sent.push(JSON.parse(m)); }
    up() { this.readyState = 1; this.onopen(); }
    msg(m: object) { this.onmessage({ data: JSON.stringify(m) }); }
    down(code = 1006) { this.readyState = 3; this.onclose({ code }); }
  }
  const docOn: Record<string, Array<() => void>> = {};
  const loc = { protocol: 'https:', host: 'nucbox.test:8443', reloads: 0, assigned: '', reload() { this.reloads++; }, assign(u: string) { this.assigned = u; } };
  const window: any = { __AIOS_HOST__: { platform: 'win32', protocol: 1 }, __AIOS_PRELOAD__: () => { /* the desktop preload: not needed here */ } };
  const document = { body: new El('body'), visibilityState: 'hidden', createElement: (tag: string) => new El(tag), addEventListener: (type: string, fn: () => void) => { (docOn[type] ||= []).push(fn); } };
  const ctx = vm.createContext({ window, document, location: loc, WebSocket: FakeWS, console, btoa, atob, setTimeout: t.setTimeout, clearTimeout: t.clear });
  vm.runInContext(fs.readFileSync('renderer/web/web-shell.js', 'utf8'), ctx, { filename: 'web-shell.js' });
  return {
    t, sockets, loc, ipc: window.__aiosIpc,
    front() { document.visibilityState = 'visible'; for (const fn of docOn.visibilitychange || []) fn(); },
  };
}

test('web-shell: a socket back on the same host raises host:reconnected; the first connection does not', async () => {
  const s = shell();
  let told = 0;
  s.ipc.on('host:reconnected', () => { told++; });
  s.sockets[0].up();
  assert.equal(s.sockets[0].sent[0].t, 'hello');
  s.sockets[0].msg({ t: 'welcome', epoch: 'e1' });
  assert.equal(told, 0);
  s.sockets[0].down();
  await s.t.advance(1000);                          // backoff 500·2¹
  assert.equal(s.sockets.length, 2);
  s.sockets[1].up();
  s.sockets[1].msg({ t: 'welcome', epoch: 'e1' });
  assert.equal(told, 1);
  assert.equal(s.loc.reloads, 0);

  // a NEW host (restarted): reload, not reconnected
  s.sockets[1].down();
  await s.t.advance(1000);
  s.sockets[2].up();
  s.sockets[2].msg({ t: 'welcome', epoch: 'e2' });
  await s.t.advance(800);
  assert.equal(told, 1);
  assert.equal(s.loc.reloads, 1);
});

test('web-shell: a page back in front reopens a closed socket at once, and only once; a revoked page never reopens', async () => {
  const s = shell();
  s.sockets[0].up(); s.sockets[0].msg({ t: 'welcome', epoch: 'e1' });
  for (let i = 0; i < 4; i++) { s.sockets[s.sockets.length - 1].down(); await s.t.advance(60_000); }   // backoff grown while hidden
  const n = s.sockets.length;
  s.sockets[n - 1].down();
  s.front();
  assert.equal(s.sockets.length, n + 1, 'reopened immediately');
  await s.t.advance(60_000);
  assert.equal(s.sockets.length, n + 1, 'the pending backoff retry was cancelled');

  // in-flight requests fail instead of hanging
  s.sockets[n].up(); s.sockets[n].msg({ t: 'welcome', epoch: 'e1' });
  const r = s.ipc.invoke('host:ptys').then(() => 'ok', (e: Error) => e.message);
  s.sockets[n].down();
  assert.match(await r, /host connection lost/);

  const v = shell();
  v.sockets[0].up(); v.sockets[0].msg({ t: 'welcome', epoch: 'e1' });
  v.sockets[0].down(4001);
  v.front();
  await v.t.advance(60_000);
  assert.equal(v.sockets.length, 1, 'revoked: no reconnect');
  assert.equal(v.loc.assigned, '/pair');
});
