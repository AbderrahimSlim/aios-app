/* HOST MODE — the phone app (/m): four tabs, the shortcut launcher, a picker and a session screen.
   The Jarvis tab is jarvis.js itself, which mounts its panel into #m-jarvis.

   Every shortcut launches exactly what the cockpit launches (renderer/app.js: ritual, runWhere's
   "new terminal", spawnNamed, pickAgent/Skill/Command) — a `claude --name <name> '<prompt>'` in a
   host terminal — and opens it in the session screen. A host terminal held by another page (a PC's
   cockpit) is not opened here: opening it would start a second session under the same name.

   Text from the host (notes, names, descriptions) is always set with textContent, never as markup. */
(function () {
  'use strict';
  const ipc = window.__aiosIpc;
  if (!ipc) return;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const pad = (n) => String(n).padStart(2, '0');
  const dayLabel = () => new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (c) => c.toUpperCase());
  const IS_WIN = ((window.__AIOS_HOST__ || {}).platform || '') === 'win32';
  /* Quoting for the host's shell, as app.js's shq (PowerShell on Windows, POSIX elsewhere). */
  const shq = (s) => { const str = String(s); return IS_WIN ? `'${str.replace(/'/g, "''")}'` : `'${str.replace(/'/g, `'\\''`)}'`; };
  const handleOf = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

  let toastTimer = null;
  function toast(text) {
    const t = $('m-toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ── host config (the claude command and the primary session's name) ────────────────────────
  let cfg = { claude: 'claude', primary: 'aios' };
  const cfgReady = (async () => {
    try {
      const c = await window.glassShell.shellConfig();
      cfg = { claude: (c && c.claudeCmd) || 'claude', primary: (c && c.primary) || 'aios' };
    } catch { /* keep defaults */ }
    $('m-primary-label').textContent = 'Lancer ' + cfg.primary;
  })();

  // ── tabs ────────────────────────────────────────────────────────────────────────────────────
  const TITLES = { jarvis: 'Jarvis', actions: 'Actions', today: 'Aujourd’hui', sessions: 'Sessions' };
  let tab = 'jarvis';
  let sessionsTimer = null;
  function show(next) {
    tab = next;
    for (const s of document.querySelectorAll('.m-tab')) s.hidden = s.dataset.tab !== next;
    for (const b of document.querySelectorAll('.m-tabs button')) {
      if (b.dataset.go === next) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    $('m-title').textContent = TITLES[next];
    $('m-sub').textContent = next === 'today' ? dayLabel() : next === 'jarvis' ? 'Hôte AIOS' : next === 'actions' ? 'Chacune s’ouvre dans une session' : '';
    clearInterval(sessionsTimer); sessionsTimer = null;
    if (next === 'sessions') { void loadSessions(); sessionsTimer = setInterval(() => { if (document.visibilityState === 'visible') void loadSessions(); }, 10000); }
    if (next === 'today') void loadToday();
    if (next === 'actions') void loadCounts();
    try { sessionStorage.setItem('m.tab', next); } catch { /* private mode */ }
  }
  for (const b of document.querySelectorAll('.m-tabs button')) b.addEventListener('click', () => show(b.dataset.go));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && tab === 'today') void loadToday(); });

  // ── the AIOS lists (agents, skills, commands, tasks) ─────────────────────────────────────────
  let lists = null;
  async function getLists(fresh) {
    if (!lists || fresh) lists = await ipc.invoke('aios:lists');
    return lists;
  }
  async function loadCounts() {
    try {
      const l = await getLists(true);
      for (const n of document.querySelectorAll('[data-count]')) {
        const v = l[n.dataset.count];
        n.textContent = Array.isArray(v) ? String(v.length) : '';
      }
    } catch { /* host unreachable: the pill says so */ }
  }

  // ── launching ───────────────────────────────────────────────────────────────────────────────
  /** A session named `name` running `prompt` (app.js ritual / runWhere "new terminal"). */
  async function launch(name, prompt) {
    await cfgReady;
    const handle = handleOf(name) || 'session';
    await openSession(handle, cfg.claude + ' --name ' + handle + ' ' + shq(prompt));
  }

  const ACTIONS = {
    primary: async () => { await cfgReady; return launch(cfg.primary, 'Start session'); },
    resume: async () => { await cfgReady; return openSession('resume', cfg.claude + ' --resume'); },
    today: () => launch('today', '/aios:today'),
    'close-session': () => launch('close-session', '/aios:close-session'),
    'close-day': () => launch('close-day', '/aios:close-day'),
    tasks: () => pickTask(),
    agent: () => pickAgent(),
    skill: () => pickSkill(),
    command: () => pickCommand(),
    ingest: () => openSheet({ title: 'Ingérer du contenu', sub: 'Une URL, un chemin ou un texte → contexte du vault', label: 'Source (facultatif)', placeholder: 'https://…', run: (src) => launch('ingest', '/aios:ingest' + (src ? ' ' + src : '')) }),
    session: () => openSheet({ title: 'Lancer une session', sub: 'Une session nommée sur l’hôte', withName: true, label: 'Tâche (facultatif)', placeholder: 'Ce que la session doit faire', run: (task, name) => {
      const h = handleOf(name);
      if (!h) { toast('Donne un nom à la session.'); return false; }
      return launch(h, task || 'Start session');
    } }),
  };
  for (const b of document.querySelectorAll('[data-act]')) {
    b.addEventListener('click', () => { const f = ACTIONS[b.dataset.act]; if (f) Promise.resolve(f()).catch((e) => toast(String(e.message || e))); });
  }

  // ── the picker ──────────────────────────────────────────────────────────────────────────────
  let pickerItems = [];
  let pickerChoose = null;
  let sheetRun = null;

  function openPicker({ title, sub, items, choose }) {
    $('m-picker-title').textContent = title;
    $('m-picker-sub').textContent = sub || '';
    $('m-picker-searchwrap').hidden = false;
    $('m-picker-search').value = '';
    $('m-picker-sheet').hidden = true;
    pickerItems = items; pickerChoose = choose;
    renderPicker('');
    $('m-picker').hidden = false;
  }
  function renderPicker(q) {
    const list = $('m-picker-list');
    const needle = q.trim().toLowerCase();
    const shown = needle ? pickerItems.filter((x) => (x.label + ' ' + (x.desc || '') + ' ' + (x.group || '')).toLowerCase().includes(needle)) : pickerItems;
    const out = [];
    let group = null;
    for (const it of shown.slice(0, 300)) {
      if (it.group && it.group !== group) { group = it.group; out.push(el('h3', 'm-pick-group', group.toUpperCase())); }
      const b = el('button', 'm-pick');
      b.type = 'button';
      b.append(el('span', 'm-pick-name', it.label));
      if (it.desc) b.append(el('span', 'm-pick-desc', it.desc));
      b.addEventListener('click', () => {
        for (const o of list.querySelectorAll('.m-pick.on')) o.classList.remove('on');
        b.classList.add('on');
        pickerChoose(it.value);
      });
      out.push(b);
    }
    if (!out.length) out.push(el('p', 'm-empty', needle ? 'Aucun résultat.' : 'Rien à proposer pour l’instant.'));
    list.replaceChildren(...out);
  }
  $('m-picker-search').addEventListener('input', (e) => renderPicker(e.target.value));

  /** The bottom sheet: an optional detail, then launch. With no list above, the sheet is the whole screen. */
  function openSheet({ title, sub, label, placeholder, withName, run, keepList }) {
    if (!keepList) {
      $('m-picker-title').textContent = title;
      $('m-picker-sub').textContent = sub || '';
      $('m-picker-searchwrap').hidden = true;
      $('m-picker-list').replaceChildren();
      $('m-picker').hidden = false;
    }
    $('m-sheet-label').textContent = label;
    $('m-sheet-text').value = '';
    $('m-sheet-text').placeholder = placeholder || '';
    $('m-sheet-name-wrap').hidden = !withName;
    $('m-sheet-name').value = '';
    $('m-picker-sheet').hidden = false;
    sheetRun = run;
  }
  $('m-picker-sheet').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sheetRun) return;
    const r = await sheetRun($('m-sheet-text').value.trim(), $('m-sheet-name').value.trim());
    if (r === false) return;
    $('m-picker').hidden = true;
  });
  const closePicker = () => { $('m-picker').hidden = true; sheetRun = null; };

  async function pickAgent() {
    const { agents } = await getLists();
    openPicker({
      title: 'Lancer un agent', sub: `${agents.length} agents · une casquette, une tâche`,
      items: agents.map((a) => ({ label: a.name, desc: a.description || '', group: a.group || '', value: a })),
      choose: (a) => openSheet({ keepList: true, label: `Tâche pour ${a.name} (facultatif)`, placeholder: 'Ce que l’agent doit faire', run: (task) => launch(a.name, '/aios:agent ' + (task ? a.name + ' — ' + task : a.name)) }),
    });
  }
  async function pickSkill() {
    const { skills } = await getLists();
    openPicker({
      title: 'Charger un skill', sub: `${skills.length} skills`,
      items: skills.map((s) => ({ label: s.name, desc: (s.description || '').slice(0, 120), group: s.group || '', value: s })),
      choose: (s) => openSheet({ keepList: true, label: `Pour quoi faire ? (facultatif)`, placeholder: 'La tâche où appliquer le skill', run: (task) => launch(s.name, 'Use the ' + s.name + ' skill' + (task ? ': ' + task : '.')) }),
    });
  }
  async function pickCommand() {
    const { commands } = await getLists();
    openPicker({
      title: 'Exécuter une commande', sub: `${commands.length} commandes aios`,
      items: commands.map((c) => ({ label: '/aios:' + c.name, desc: (c.description || '').slice(0, 120), value: c })),
      choose: (c) => openSheet({ keepList: true, label: c.argumentHint ? `Arguments (${c.argumentHint})` : 'Arguments (facultatif)', placeholder: '', run: (args) => launch(c.name, '/aios:' + c.name + (args ? ' ' + args : '')) }),
    });
  }
  async function pickTask() {
    const { suggestions } = await getLists(true);
    openPicker({
      title: 'Tâches pour les agents', sub: 'Depuis « Agents can handle » de la note du jour',
      items: suggestions.map((s) => ({ label: s.task, desc: s.agent ? 'agent : ' + s.agent : 'commande : ' + (s.command || ''), value: s })),
      choose: (s) => {
        closePicker();
        if (s.agent) void launch(s.agent, '/aios:agent ' + s.agent + ' — ' + s.task);
        else if (s.command) void launch(s.command.replace(/^\/(aios:)?/, '').split(/\s/)[0], s.command + (s.url ? ' ' + s.url : ''));
      },
    });
  }

  // ── the session screen ──────────────────────────────────────────────────────────────────────
  /* Two views of one host terminal. CHAT (default): the conversation read from Claude Code's transcript
     by the host (chatSkin, the cockpit's own chat view), the reply being written read off the screen,
     and the dialogs it asks drawn as buttons. TERMINAL: the raw xterm. The xterm exists in both modes:
     in chat mode it is hidden, kept wide, and its screen is what the host reads the dialogs from. */
  const views = new Map();        // name → view
  const byId = new Map();         // pty id → view
  let current = null;
  let mode = (() => { try { return localStorage.getItem('m.view') === 'term' ? 'term' : 'chat'; } catch { return 'chat'; } })();
  const CHAT_COLS = 100, CHAT_ROWS = 40;
  const KEY_OK = /^(?:\x1b\[[AB]|\r|[0-9])+$/;          // what a dialog option may write (app.js CHAT_KEY_OK)
  const KEY_CHUNK = /\x1b\[[0-9;]*[A-Za-z]|\r|[^\x1b\r]/g;

  function sizePty(v) {
    if (!v || !v.term || v.id == null || v.exited) return;
    try {
      if (mode === 'term' && v === current && v.fit) v.fit.fit();
      else if (mode === 'chat' && (v.term.cols !== CHAT_COLS || v.term.rows !== CHAT_ROWS)) v.term.resize(CHAT_COLS, CHAT_ROWS);
      ipc.send('pty:resize', { id: v.id, cols: v.term.cols, rows: v.term.rows });
    } catch { /* not laid out yet */ }
  }
  function applyMode() {
    const v = current;
    $('m-chat').hidden = mode !== 'chat';
    $('m-term-host').hidden = mode !== 'term';
    $('m-view-toggle').textContent = mode === 'chat' ? 'Terminal' : 'Chat';
    $('m-view-toggle').setAttribute('aria-pressed', mode === 'term' ? 'true' : 'false');
    if (v) { for (const b of $('m-term-host').children) b.hidden = b !== v.box; for (const b of $('m-chat-list').children) b.hidden = b !== v.chatBox; }
    paintChat();
    requestAnimationFrame(() => sizePty(v));
  }
  $('m-view-toggle').addEventListener('click', () => {
    mode = mode === 'chat' ? 'term' : 'chat';
    try { localStorage.setItem('m.view', mode); } catch { /* private mode */ }
    applyMode();
  });

  function showView(v) {
    current = v;
    $('m-session-name').textContent = v.name;
    $('m-session-state').textContent = v.exited ? 'Session terminée' : 'En cours sur l’hôte';
    $('m-session-state').classList.toggle('m-live', !v.exited);
    $('m-session').hidden = false;
    applyMode();
    scrollChat(true);
  }
  function makeView(name) {
    const box = el('div', 'm-term');
    $('m-term-host').append(box);
    const chatBox = el('div', 'm-chat-box');
    $('m-chat-list').append(chatBox);
    const v = { id: null, term: null, fit: null, box, chatBox, exited: false, name,
      items: new Map(), pending: [], sid: null, watched: undefined, prompt: null, promptUsed: false, turnOpen: false,
      stream: '', adopt: '', earlier: false, chatState: 'Connexion à la conversation…', screenTimer: 0, sidTimer: 0 };
    if (window.Terminal) {
      v.term = new window.Terminal({
        cols: CHAT_COLS, rows: CHAT_ROWS,
        fontSize: 11.5, lineHeight: 1.15, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        disableStdin: true, scrollback: 5000, cursorBlink: false, allowProposedApi: false,
        theme: { background: '#0A0D12', foreground: '#C9D1D9', cursor: '#5CC8FF', selectionBackground: 'rgba(92,200,255,.25)',
          black: '#0E1116', red: '#FF7B72', green: '#3FB950', yellow: '#F0A04B', blue: '#5CC8FF', magenta: '#D2A8FF', cyan: '#56D4DD', white: '#C9D1D9',
          brightBlack: '#6E7681', brightRed: '#FFA198', brightGreen: '#56D364', brightYellow: '#F8C77E', brightBlue: '#8FDBFF', brightMagenta: '#E2C5FF', brightCyan: '#7EE3EA', brightWhite: '#F0F6FC' },
      });
      if (window.FitAddon) { v.fit = new window.FitAddon.FitAddon(); v.term.loadAddon(v.fit); }
      v.term.open(box);
      enableTouchScroll(v);
      /* The host reads the dialogs from what the terminal SHOWS: send its last rows once a repaint settles. */
      v.term.onWriteParsed(() => {
        clearTimeout(v.screenTimer);
        v.screenTimer = setTimeout(() => {
          if (v.id == null || v.exited || v.watched === undefined) return;
          const b = v.term.buffer.active, rows = [];
          for (let i = Math.max(0, b.length - Math.max(60, v.term.rows)); i < b.length; i++) { const l = b.getLine(i); if (l) rows.push(l.translateToString(true)); }
          ipc.send('chatSkin:screen', v.id, rows.join('\n'));
        }, 80);
      });
    } else {
      box.append(el('p', 'm-empty', 'Terminal indisponible.'));
    }
    views.set(name, v);
    return v;
  }

  /* xterm scrolls with a wheel, not a finger: on iOS its viewport sits under the rendered rows and
     never sees the swipe. Swipes are turned into scrollLines here, with a short glide after release. */
  function enableTouchScroll(v) {
    let lastY = 0, acc = 0, vel = 0, lastT = 0, glide = 0;
    const lineH = () => Math.max(8, v.box.clientHeight / Math.max(1, v.term.rows));
    const move = (px) => {
      acc += px;
      const n = Math.trunc(acc / lineH());
      if (n) { v.term.scrollLines(n); acc -= n * lineH(); }
    };
    v.box.addEventListener('touchstart', (e) => {
      cancelAnimationFrame(glide);
      lastY = e.touches[0].clientY; lastT = performance.now(); acc = 0; vel = 0;
    }, { passive: true });
    v.box.addEventListener('touchmove', (e) => {
      const y = e.touches[0].clientY, t = performance.now();
      const dy = lastY - y;
      vel = dy / Math.max(1, t - lastT);
      lastY = y; lastT = t;
      move(dy);
      e.preventDefault();
    }, { passive: false });
    v.box.addEventListener('touchend', () => {
      let speed = vel * 16;                       // px per frame
      const step = () => {
        if (Math.abs(speed) < 0.5) return;
        move(speed); speed *= 0.94;
        glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    }, { passive: true });
  }

  async function openSession(name, cmd) {
    const mine = views.get(name);
    if (mine && !mine.exited) { showView(mine); return; }
    let ptys = [];
    try { ptys = await ipc.invoke('host:ptys'); } catch { toast('Hôte injoignable.'); return; }
    const live = ptys.filter((p) => p.name === name).pop();
    if (live && live.attached && !live.mine) { toast(`« ${name} » est ouverte sur un autre appareil : ferme-la là-bas pour l’ouvrir ici.`); return; }
    if (!live && !cmd) { toast(`« ${name} » n’est plus sur l’hôte.`); void loadSessions(); return; }
    if (mine) { endChat(mine); mine.box.remove(); mine.chatBox.remove(); views.delete(name); }
    const v = makeView(name);
    showView(v);
    if (mode === 'term' && v.fit) { try { v.fit.fit(); } catch { /* hidden */ } }
    const cols = (v.term && v.term.cols) || CHAT_COLS, rows = (v.term && v.term.rows) || CHAT_ROWS;
    try {
      v.id = await ipc.invoke('pty:spawn', { cols, rows, cmd, name });
    } catch (e) { toast('Lancement refusé : ' + (e.message || e)); return; }
    byId.set(v.id, v);
    /* A new terminal runs its command once sized (app.js does the same); a terminal taken back
       swallows this run on the host, so nothing is typed into the live session. */
    if (cmd) setTimeout(() => { void ipc.invoke('pty:run', { id: v.id, cmd }).catch(() => {}); }, 500);
    sizePty(v);
    void startChat(v);
  }

  // ── chat: following the conversation ────────────────────────────────────────────────────────
  /** The conversation id of the Claude session in this terminal, from Claude Code's registry: matched by
      the terminal's name, or a name the session had before a rename. */
  async function findSid(v) {
    try {
      const regs = await ipc.invoke('host:sessions');
      const r = regs.find((x) => x.name === v.name) || regs.find((x) => (x.aliases || []).includes(v.name));
      return (r && r.sessionId) || null;
    } catch { return null; }
  }
  async function watch(v, sid) {
    v.watched = sid;
    try {
      const r = await ipc.invoke('chatSkin:watch', v.id, sid);
      if (r && !r.ok && r.error !== 'not-found') { v.chatState = 'Vue chat indisponible (' + r.error + ') — passe en Terminal.'; paintChat(); }
    } catch (e) { v.chatState = 'Vue chat indisponible — passe en Terminal.'; paintChat(); }
  }
  async function startChat(v) {
    /* Watch with no id first: the host already follows the terminal's dialogs (a new session can stop on
       the folder-trust question before it has an id). Then follow the transcript once the id is known,
       and keep checking: /clear or a resume changes it. */
    await watch(v, null);
    const tick = async () => {
      if (v.exited || !byId.has(v.id)) return;
      const sid = await findSid(v);
      if (sid && sid !== v.sid) {
        if (v.sid) { v.items.clear(); v.chatBox.replaceChildren(...v.pending.map((p) => p.node)); }
        v.sid = sid; v.chatState = '';
        await watch(v, sid);
        paintChat();
      } else if (!sid && !v.sid) { v.chatState = 'La conversation apparaîtra dès que la session aura démarré.'; paintChat(); }
      v.sidTimer = setTimeout(tick, v.sid ? 10000 : 2000);
    };
    void tick();
  }
  function endChat(v) {
    clearTimeout(v.sidTimer); clearTimeout(v.screenTimer);
    if (v.id != null) void ipc.invoke('chatSkin:unwatch', v.id).catch(() => {});
  }

  const nearBottom = () => { const c = $('m-chat'); return c.scrollHeight - c.scrollTop - c.clientHeight < 120; };
  function scrollChat(force) { const c = $('m-chat'); if (force || nearBottom()) requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; }); }

  ipc.on('chatSkin:event', (_e, ev) => {
    const v = ev && byId.get(ev.paneId);
    if (!v) return;
    const stick = v === current && nearBottom();
    switch (ev.type) {
      case 'reset': v.items.clear(); v.chatBox.replaceChildren(...v.pending.map((p) => p.node)); v.chatState = ''; break;
      case 'span': v.earlier = !!ev.earlier; break;
      case 'earlier': {
        const frag = document.createDocumentFragment();
        for (const it of ev.items || []) { const n = renderItem(it); v.items.set(it.uuid, n); frag.append(n); }
        v.chatBox.prepend(frag); v.earlier = !!ev.more; break;
      }
      case 'items':
        for (const it of ev.items || []) {
          const n = renderItem(it);
          const old = v.items.get(it.uuid);
          settlePending(v, it);
          /* What is still being sent stays last: a line read from the transcript goes above it. */
          if (old) old.replaceWith(n); else if (v.pending.length) v.chatBox.insertBefore(n, v.pending[0].node); else v.chatBox.append(n);
          v.items.set(it.uuid, n);
          if (v.adopt && it.uuid === v.adopt) { v.stream = ''; v.adopt = ''; }
        }
        if (v.items.size) v.chatState = '';
        break;
      case 'turn': v.turnOpen = !!ev.open; if (!ev.open) { v.stream = ''; } break;
      case 'prompt': v.prompt = ev.kind ? ev : null; if (!ev.refresh) v.promptUsed = false; break;
      case 'stream':
        if (typeof ev.text === 'string') v.stream = ev.text;
        else if (ev.adopt) v.adopt = ev.adopt;
        break;
      case 'missing': if (!v.items.size) v.chatState = 'La conversation apparaîtra au premier message.'; break;
      case 'error': v.chatState = 'Vue chat indisponible (' + ev.code + ') — passe en Terminal.'; break;
      default: return;
    }
    if (v === current) { paintChat(); if (stick) scrollChat(true); }
  });

  function paintChat() {
    const v = current;
    if (!v) return;
    const chat = mode === 'chat';
    $('m-chat-state').textContent = v.chatState || '';
    $('m-chat-state').hidden = !v.chatState;
    $('m-chat-earlier').hidden = !(chat && v.earlier);
    const s = $('m-chat-stream');
    s.hidden = !(chat && v.stream);
    if (chat && v.stream) s.replaceChildren(...mdToDom(v.stream));
    $('m-turn').hidden = !(chat && v.turnOpen && !v.exited);
    /* A dialog read well enough to draw as buttons replaces the quick keys; one that was not keeps them. */
    const p = v.prompt;
    const withOptions = !!(p && Array.isArray(p.options) && p.options.length);
    $('m-prompt').hidden = !(chat && p && !v.exited);
    if (chat && p) {
      $('m-prompt-q').textContent = [p.header, p.question || (withOptions ? '' : (p.hint || 'Claude attend une réponse dans le terminal.'))].filter(Boolean).join(' — ');
      const opts = $('m-prompt-opts');
      opts.replaceChildren(...(withOptions ? p.options : []).map((o) => {
        const b = el('button', 'm-opt' + (o.selected ? ' on' : ''));
        b.type = 'button'; b.disabled = v.promptUsed;
        b.append(el('span', 'm-opt-label', (o.n != null ? o.n + '. ' : '') + o.label));
        if (o.desc) b.append(el('span', 'm-opt-desc', o.desc));
        b.addEventListener('click', () => {
          if (!sendKey(v, o.key)) return;
          v.promptUsed = true; paintChat();
          if (o.freeText) $('m-send-text').focus();
        });
        return b;
      }));
    }
    $('m-keys').hidden = chat && !(p && !withOptions);
  }
  function sendKey(v, key) {
    if (typeof key !== 'string' || !KEY_OK.test(key) || v.exited) return false;
    (key.match(KEY_CHUNK) || []).forEach((chunk, n) => setTimeout(() => ipc.send('pty:write', { id: v.id, data: chunk }), n * 60));
    return true;
  }
  $('m-chat-earlier').addEventListener('click', () => { if (current) void ipc.invoke('chatSkin:earlier', current.id).catch(() => {}); });
  $('m-interrupt').addEventListener('click', () => write('\x1b'));

  // ── chat: drawing an item (all text through textContent) ────────────────────────────────────
  function renderItem(it) {
    if (it.role === 'user') return el('div', 'm-msg m-msg-me', it.text || '');
    if (it.role === 'assistant') { const d = el('div', 'm-msg m-msg-claude'); d.append(...mdToDom(it.text || '')); return d; }
    if (it.role === 'tool' && it.tool) {
      const t = it.tool;
      const d = document.createElement('details');
      d.className = 'm-tool ' + t.status;
      if (t.own && !t.fold) d.open = true;
      const s = el('summary', null);
      s.append(el('span', 'm-tool-dot'), el('span', 'm-tool-name', t.name), el('span', 'm-tool-sum', t.summary || ''));
      d.append(s);
      if (t.output) d.append(el('pre', 'm-tool-out', t.output + (t.outputTruncated ? '\n…' : '')));
      return d;
    }
    return el('div', it.error ? 'm-msg m-msg-error' : 'm-sys', it.text || '');
  }

  /** Markdown → DOM, for Claude's replies. A small subset (paragraphs, headings, lists, quotes, code
      blocks, `code`, **bold**, *italic*, links), built node by node: the text never becomes markup. */
  function mdToDom(md) {
    const out = [];
    const parts = String(md).split(/^```[^\n]*\n?/m);
    parts.forEach((part, i) => {
      if (i % 2 === 1) { out.push(el('pre', 'm-code', part.replace(/\n$/, ''))); return; }
      let list = null, para = [];
      const flush = () => { if (para.length) { const p = document.createElement('p'); inline(p, para.join(' ')); out.push(p); para = []; } };
      for (const raw of part.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        let m;
        if (!line.trim()) { flush(); list = null; continue; }
        if ((m = /^#{1,6}\s+(.*)$/.exec(line))) { flush(); list = null; const h = document.createElement('p'); h.className = 'm-md-h'; inline(h, m[1]); out.push(h); continue; }
        if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
          flush();
          const ordered = /\d/.test(m[1]);
          if (!list || list.ordered !== ordered) { list = { node: document.createElement(ordered ? 'ol' : 'ul'), ordered }; out.push(list.node); }
          const li = document.createElement('li'); inline(li, m[2]); list.node.append(li); continue;
        }
        if ((m = /^>\s?(.*)$/.exec(line))) { flush(); list = null; const q = document.createElement('blockquote'); inline(q, m[1]); out.push(q); continue; }
        if (/^\s*\|/.test(line)) { flush(); list = null; out.push(el('pre', 'm-code m-table', line.trim())); continue; }
        if (list && /^\s{2,}\S/.test(raw)) { const li = list.node.lastElementChild; if (li) { li.append(' '); inline(li, line.trim()); continue; } }
        list = null; para.push(line.trim());
      }
      flush();
    });
    return out;
  }
  function inline(parent, text) {
    const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;
    let at = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > at) parent.append(text.slice(at, m.index));
      const tok = m[0];
      if (tok[0] === '`') parent.append(el('code', null, tok.slice(1, -1)));
      else if (tok.startsWith('**') || tok.startsWith('__')) parent.append(el('strong', null, tok.slice(2, -2)));
      else if (tok[0] === '*') parent.append(el('em', null, tok.slice(1, -1)));
      else {
        const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
        if (lm && /^https?:\/\//i.test(lm[2])) { const a = el('a', null, lm[1]); a.href = lm[2]; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
        else parent.append(lm ? lm[1] : tok);
      }
      at = m.index + tok.length;
    }
    if (at < text.length) parent.append(text.slice(at));
  }

  ipc.on('pty:data', (_e, m) => { const v = m && byId.get(m.id); if (v && v.term) v.term.write(String(m.data)); });
  ipc.on('pty:exit', (_e, m) => {
    const v = m && byId.get(m.id);
    if (!v) return;
    v.exited = true; v.prompt = null; v.turnOpen = false;
    endChat(v);
    if (v.term) v.term.write('\r\n\x1b[90m[session terminée]\x1b[0m\r\n');
    if (current === v) showView(v);
  });

  /* The socket came back after the page was hidden (iOS drops it): the host let go of this page's terminals and chat
     watches when the old socket closed, so every write and watch from here would be refused in silence — the chat
     froze and what was typed vanished until the app was restarted. Take each open terminal back the way openSession
     does (pty:spawn by name adopts the live one, never starts a second), then follow its conversation again: the watch
     re-reads the transcript, so what was said while away appears too. A terminal another device took meanwhile is
     left to it. */
  ipc.on('host:reconnected', () => { void retakeAll(); });
  async function retakeAll() {
    let ptys;
    try { ptys = await ipc.invoke('host:ptys'); } catch { return; }   // lost again: the next reconnect retries
    for (const v of [...views.values()]) {
      if (v.exited || v.id == null) continue;
      const live = ptys.find((p) => p.id === v.id);
      if (!live) {
        v.exited = true; v.prompt = null; v.turnOpen = false; endChat(v);
        if (v.term) v.term.write('\r\n\x1b[90m[session terminée]\x1b[0m\r\n');
        if (current === v) showView(v);
        continue;
      }
      if (live.attached && !live.mine) {
        v.chatState = `« ${v.name} » a été ouverte sur un autre appareil : ferme-la là-bas puis rouvre-la ici.`;
        if (current === v) paintChat();
        continue;
      }
      let id;
      try { id = await ipc.invoke('pty:spawn', { cols: (v.term && v.term.cols) || CHAT_COLS, rows: (v.term && v.term.rows) || CHAT_ROWS, name: v.name }); }
      catch { continue; }
      if (id !== v.id) { byId.delete(v.id); v.id = id; byId.set(id, v); }
      sizePty(v);
      v.watched = undefined;
      await watch(v, null);
      if (v.sid) await watch(v, v.sid);
      if (current === v) paintChat();
    }
  }

  /* What the operator sends shows at once, marked as sending, and gives way to the transcript's own line when it lands
     (the chat draws only what the transcript holds, so without this a message sat invisible until then, and forever
     if it never arrived). Still unseen after a minute → marked, so a message lost on the way is never silent. A
     message typed during a running turn lands only at the turn's next step, hence the long wait. */
  const PENDING_MS = 60000;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  function addPending(v, text) {
    const node = el('div', 'm-msg m-msg-me m-pending', text);
    const p = { key: norm(text), node, timer: 0 };
    p.timer = setTimeout(() => node.classList.add('m-unsent'), PENDING_MS);
    v.pending.push(p);
    v.chatBox.append(node);
  }
  function settlePending(v, item) {
    if (!item || item.role !== 'user' || !v.pending.length) return;
    const i = v.pending.findIndex((p) => p.key === norm(item.text));
    if (i < 0) return;
    const [p] = v.pending.splice(i, 1);
    clearTimeout(p.timer);
    p.node.remove();
  }

  const KEYS = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', tab: '\t', ctrlc: '\x03' };
  const write = (data) => { if (current && current.id != null && !current.exited) ipc.send('pty:write', { id: current.id, data }); };
  for (const b of document.querySelectorAll('[data-key]')) {
    b.addEventListener('click', () => write(KEYS[b.dataset.key] || b.dataset.key));
  }
  $('m-send').addEventListener('submit', (e) => {
    e.preventDefault();
    const box = $('m-send-text');
    const text = box.value;
    if (!text.trim()) { if (mode === 'term') write('\r'); return; }
    if (mode === 'chat' && current && current.prompt && current.prompt.options && current.prompt.options.length && !current.promptUsed) {
      toast('Claude attend d’abord ta réponse à sa question, au-dessus.'); return;
    }
    box.value = '';
    if (mode === 'chat' && current && current.id != null && !current.exited) addPending(current, text);
    /* Pasted then submitted, as the host's headless send does: Claude Code takes it as one message. */
    write('\x1b[200~' + text + '\x1b[201~');
    setTimeout(() => write('\r'), 250);
    scrollChat(true);
  });
  $('m-send-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('m-send').requestSubmit(); } });

  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => {
      if (b.dataset.close === 'picker') closePicker();
      else { $('m-session').hidden = true; current = null; if (tab === 'sessions') void loadSessions(); }
    });
  }
  window.addEventListener('resize', () => requestAnimationFrame(() => sizePty(current)));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => requestAnimationFrame(() => sizePty(current)));

  // ── sessions tab ────────────────────────────────────────────────────────────────────────────
  function ago(ms) {
    if (!ms) return '';
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return 'à l’instant';
    if (m < 60) return `il y a ${m} min`;
    const h = Math.round(m / 60);
    return h < 24 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
  }
  async function loadSessions() {
    const list = $('m-sessions-list');
    let regs, ptys;
    try { [regs, ptys] = await Promise.all([ipc.invoke('host:sessions'), ipc.invoke('host:ptys')]); }
    catch { list.replaceChildren(el('p', 'm-empty', 'Hôte injoignable.')); return; }
    /* A host terminal is named once, at launch; the Claude session inside may have been renamed since,
       so it is matched by its current name or a former one. A matched session is listed once, as the terminal. */
    const regOf = (name) => regs.find((r) => r.name === name) || regs.find((r) => (r.aliases || []).includes(name));
    /* Claude Code's registry: busy = working; idle = its turn is over, it waits for you. A host terminal
       with no session in the registry has no Claude running in it (a shell, or a session that ended). */
    const stateOf = (r) => !r ? { status: 'Terminal', tone: 'idle' } : r.status === 'busy' ? { status: 'Active', tone: 'live' } : { status: 'Attend ta réponse', tone: 'warn' };
    const rows = [];
    const seen = new Set();
    const matched = new Set();
    for (const p of ptys.slice().reverse()) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      const r = regOf(p.name);
      if (r) matched.add(r);
      const elsewhere = p.attached && !p.mine;
      const st = stateOf(r);
      rows.push({ name: p.name,
        detail: [r && r.name !== p.name ? '« ' + r.name + ' »' : '', r && r.folder, r ? ago(r.updatedAt) : 'pas de session Claude'].filter(Boolean).join(' · '),
        status: elsewhere ? 'Ouverte ailleurs' : st.status, tone: elsewhere ? 'off' : st.tone, open: !elsewhere, at: (r && r.updatedAt) || 0 });
    }
    for (const r of regs) {
      if (matched.has(r)) continue;
      const st = stateOf(r);
      rows.push({ name: r.name, detail: [r.folder, r.entrypoint === 'claude-vscode' ? 'VS Code' : 'hors de l’hôte', ago(r.updatedAt)].filter(Boolean).join(' · '),
        status: st.status, tone: 'off ' + st.tone, open: false, at: r.updatedAt || 0 });
    }
    $('m-sub').textContent = `${rows.filter((x) => x.open).length} ouvrable${rows.filter((x) => x.open).length > 1 ? 's' : ''} ici · ${rows.length} en tout`;
    if (!rows.length) { list.replaceChildren(el('p', 'm-empty', 'Aucune session en cours.')); return; }
    rows.sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at);
    list.replaceChildren(...rows.map((x) => {
      const row = el(x.open ? 'button' : 'div', 'm-session ' + x.tone + (x.open ? '' : ' disabled'));
      if (x.open) { row.type = 'button'; row.addEventListener('click', () => void openSession(x.name, null)); }
      const dot = el('span', 'm-dot'); dot.setAttribute('aria-hidden', 'true');
      const text = el('span', 'm-session-text');
      text.append(el('span', 'm-session-name', x.name), el('span', 'm-session-detail', x.detail));
      row.append(dot, text, el('span', 'm-session-status', x.status));
      return row;
    }));
  }

  // ── today's note ────────────────────────────────────────────────────────────────────────────
  /** Markdown → plain display text: wikilinks keep their label, emphasis and code marks go. */
  const plain = (s) => s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/(^|[^*])\*([^*]+)\*/g, '$1$2').replace(/`([^`]+)`/g, '$1').trim();

  function renderNote(md) {
    const out = [];
    const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim() || /^\s*(---|\*\*\*)\s*$/.test(line) || /^\s*>/.test(line)) continue;
      let m;
      if (/^#\s+/.test(line)) continue;                                      // the note's own title: the header says the day
      if ((m = /^##\s+(.*)$/.exec(line))) { out.push(el('h2', null, plain(m[1]))); continue; }
      if ((m = /^#{3,6}\s+(.*)$/.exec(line))) { out.push(el('h3', null, plain(m[1]))); continue; }
      if ((m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
        const done = m[1] !== ' ';
        const row = el('label', 'm-task' + (done ? ' done' : ''));
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = done; box.disabled = true;
        row.append(box, el('span', null, plain(m[2])));
        out.push(row); continue;
      }
      if ((m = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line))) { out.push(el('div', 'm-li', plain(m[1]))); continue; }
      out.push(el('p', null, plain(line)));
    }
    return out;
  }

  async function loadToday() {
    const box = $('m-today-note');
    const d = new Date();
    try {
      const roots = await ipc.invoke('fs:roots');
      if (!roots || !roots.vault) { box.replaceChildren(el('p', 'm-empty', 'Vault introuvable sur l’hôte.')); return; }
      const sep = roots.vault.includes('\\') ? '\\' : '/';
      const file = [roots.vault, '01 - calendar', `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`].join(sep);
      const r = await ipc.invoke('fs:read', file);
      if (!r || typeof r.content !== 'string') { box.replaceChildren(el('p', 'm-empty', 'Pas encore de note pour aujourd’hui — lance « Planifier ma journée » dans Actions.')); return; }
      box.replaceChildren(...renderNote(r.content));
    } catch {
      box.replaceChildren(el('p', 'm-empty', 'Hôte injoignable.'));
    }
  }

  /* jarvis.js draws its buttons with emoji; here they get the app's stroke icons. It runs after this
     file, so wait for the document to finish loading. Static markup, never data. */
  const ICON_MIC = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';
  const ICON_STOP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  document.addEventListener('DOMContentLoaded', () => {
    const mic = $('jarvis-mic');
    if (mic) { mic.innerHTML = ICON_MIC; mic.setAttribute('aria-label', 'Micro'); }
    const stop = mic && mic.nextElementSibling;
    if (stop && stop.tagName === 'BUTTON') { stop.innerHTML = ICON_STOP; stop.setAttribute('aria-label', 'Arrêter Jarvis'); }
  });

  let start = 'jarvis';
  try { start = sessionStorage.getItem('m.tab') || 'jarvis'; } catch { /* private mode */ }
  show(TITLES[start] ? start : 'jarvis');
})();
