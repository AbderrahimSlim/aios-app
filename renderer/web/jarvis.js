/* Jarvis panel (host mode): an orb, a transcript, a text box and a microphone.

   Engines (decided by the host, src/jarvis/voice.ts):
   - gradium: the mic streams 24 kHz PCM to the host, which recognises it; replies come back as PCM.
   - browser: this page's Web Speech API recognises and speaks; the host only exchanges text.
   Anti-echo (on by default): while Jarvis speaks, the mic is not sent, so its own voice is never heard
   as the operator. With a headset, turn it off to interrupt Jarvis by speaking (barge-in). */
(function () {
  'use strict';
  const ipc = window.__aiosIpc;
  if (!ipc || !window.glassShell || !window.glassShell.hostMode) return;

  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const k of kids) e.append(k);
    return e;
  };

  let state = { stt: 'browser', tts: 'browser', language: 'fr' };
  let current = null;              // the jarvis bubble being written
  const tools = new Map();
  let antiEcho = localStorage.getItem('jarvis.antiEcho') !== '0';
  let speaking = false;

  // ── UI ──────────────────────────────────────────────────────────────────────────────────────
  const orb = el('button', { id: 'jarvis-orb', title: 'Jarvis (Alt+J)', 'aria-label': 'Jarvis' });
  const log = el('div', { id: 'jarvis-log', 'aria-live': 'polite' });
  const input = el('textarea', { id: 'jarvis-input', placeholder: 'Parle ou écris à Jarvis…', rows: '1' });
  const mic = el('button', { id: 'jarvis-mic', title: 'Micro' }, '🎙');
  const stopBtn = el('button', { title: 'Stop' }, '■');
  const stateEl = el('span', { class: 'jv-state' }, '');
  const echoBox = el('input', { type: 'checkbox' });
  echoBox.checked = antiEcho;
  echoBox.addEventListener('change', () => { antiEcho = echoBox.checked; localStorage.setItem('jarvis.antiEcho', antiEcho ? '1' : '0'); });
  const panel = el('div', { id: 'jarvis-panel', role: 'dialog', 'aria-label': 'Jarvis' },
    el('header', {}, 'Jarvis', stateEl, el('button', { title: 'Nouvelle conversation', onclick: () => { if (confirm('Nouvelle conversation avec Jarvis ?')) void ipc.invoke('jarvis:reset'); } }, '↺')),
    log,
    el('div', { class: 'jv-opts' }, el('label', {}, echoBox, ' anti-écho (casque : décocher pour couper Jarvis en parlant)')),
    el('footer', {}, input, mic, stopBtn));
  const link = el('link', { rel: 'stylesheet', href: '/web/jarvis.css' });
  document.head.append(link);
  document.body.append(orb, panel);

  const setOrb = (s) => { orb.className = s || ''; };
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const add = (cls, text) => { const b = el('div', { class: 'jv-msg ' + cls }, text); log.append(b); scroll(); return b; };
  let partial = null;
  const showPartial = (t) => { if (!partial) partial = add('jv-partial', ''); partial.textContent = t; scroll(); };
  const clearPartial = () => { if (partial) { partial.remove(); partial = null; } };

  orb.addEventListener('click', () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) input.focus(); });
  document.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); orb.click(); } });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; void ipc.invoke('jarvis:say', t); } }
  });
  stopBtn.addEventListener('click', () => { stopAudio(); void ipc.invoke('jarvis:interrupt'); });

  // ── audio out ───────────────────────────────────────────────────────────────────────────────
  let playCtx = null, nextAt = 0;
  const sources = new Set();
  function playPcm(b64, rate) {
    if (!playCtx) playCtx = new AudioContext();
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = playCtx.createBuffer(1, n, rate || 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 0x8000) v -= 0x10000; ch[i] = v / 0x8000; }
    const src = playCtx.createBufferSource();
    src.buffer = buf; src.connect(playCtx.destination);
    const at = Math.max(playCtx.currentTime + 0.03, nextAt);
    src.start(at); nextAt = at + buf.duration;
    sources.add(src);
    speaking = true; setOrb('speaking');
    src.onended = () => { sources.delete(src); if (!sources.size) { speaking = false; setOrb(''); } };
  }
  function speakText(text, lang) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'fr' ? 'fr-FR' : lang;
    const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith(u.lang.slice(0, 2)));
    if (v) u.voice = v;
    u.onstart = () => { speaking = true; setOrb('speaking'); };
    u.onend = () => { if (!speechSynthesis.speaking) { speaking = false; setOrb(''); } };
    speechSynthesis.speak(u);
  }
  function stopAudio() {
    for (const s of sources) { try { s.stop(); } catch { /* ended */ } }
    sources.clear(); nextAt = 0;
    try { speechSynthesis.cancel(); } catch { /* none */ }
    speaking = false; setOrb('');
  }

  // ── audio in ────────────────────────────────────────────────────────────────────────────────
  let micOn = false, micCtx = null, micStream = null, recog = null;
  function b64(buf) { const u8 = new Uint8Array(buf); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  async function startMic() {
    if (state.stt === 'gradium') {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      micCtx = new AudioContext({ sampleRate: 24000 });
      await micCtx.audioWorklet.addModule('/web/jarvis-worklet.js');
      const node = new AudioWorkletNode(micCtx, 'jarvis-mic');
      node.port.onmessage = (e) => { if (!(antiEcho && speaking)) ipc.send('jarvis:mic', b64(e.data)); };
      micCtx.createMediaStreamSource(micStream).connect(node);
      ipc.send('jarvis:micStart');
    } else {
      const R = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!R) { add('jv-error', 'Ce navigateur ne sait pas reconnaître la voix : utilise Edge ou Chrome, ou configure Gradium sur l’hôte.'); return; }
      recog = new R();
      recog.lang = state.language === 'fr' ? 'fr-FR' : state.language;
      recog.continuous = true; recog.interimResults = true;
      recog.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (antiEcho && speaking) continue;
          if (!antiEcho && speaking) { stopAudio(); void ipc.invoke('jarvis:interrupt'); }
          if (r.isFinal) { clearPartial(); const t = r[0].transcript.trim(); if (t) void ipc.invoke('jarvis:say', t); }
          else showPartial(r[0].transcript);
        }
      };
      recog.onend = () => { if (micOn) { try { recog.start(); } catch { /* restarting */ } } };
      recog.onerror = (e) => { if (e.error === 'not-allowed') { add('jv-error', 'Micro refusé : il faut https (tailscale serve) ou localhost.'); stopMic(); } };
      recog.start();
    }
    micOn = true; mic.classList.add('on'); setOrb('listening');
  }
  function stopMic() {
    micOn = false; mic.classList.remove('on');
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (micCtx) { void micCtx.close(); micCtx = null; ipc.send('jarvis:micStop'); }
    if (recog) { try { recog.stop(); } catch { /* stopped */ } recog = null; }
    clearPartial(); if (!speaking) setOrb('');
  }
  mic.addEventListener('click', () => { if (micOn) stopMic(); else startMic().catch((e) => add('jv-error', 'Micro : ' + e.message)); });

  // ── events from the host ────────────────────────────────────────────────────────────────────
  ipc.on('jarvis:audio', (_e, m) => playPcm(m.b64, m.rate));
  ipc.on('jarvis:speak', (_e, m) => speakText(m.text, m.lang));
  ipc.on('jarvis:clearAudio', () => stopAudio());
  ipc.on('jarvis:event', (_e, ev) => {
    switch (ev.type) {
      case 'user': clearPartial(); add('jv-user', ev.text); current = null; break;
      case 'partial': showPartial(ev.text); break;
      case 'listening': setOrb('listening'); break;
      case 'turn_start': current = null; setOrb('thinking'); break;
      case 'delta': if (!current) current = add('jv-jarvis', ''); current.textContent += ev.text; scroll(); break;
      case 'tool': { const t = el('div', { class: 'jv-tool run' }, ev.text); tools.set(ev.id, t); log.append(t); scroll(); current = null; break; }
      case 'tool_done': { const t = tools.get(ev.id); if (t) t.className = 'jv-tool ' + (ev.ok ? 'done' : 'failed'); break; }
      case 'turn_done': if (ev.error) add('jv-error', ev.error); current = null; if (!speaking) setOrb(micOn ? 'listening' : ''); break;
      case 'status': stateEl.textContent = { starting: 'démarrage…', ready: '', busy: 'réfléchit…', stopped: '' }[ev.state] || ''; break;
      case 'interrupted': stopAudio(); add('jv-tool', 'interrompu'); break;
      case 'reset': log.textContent = ''; current = null; break;
      case 'error': add('jv-error', ev.text); break;
    }
  });

  ipc.invoke('jarvis:state').then((s) => {
    state = s;
    for (const h of s.history || []) add(h.role === 'user' ? 'jv-user' : h.role === 'jarvis' ? 'jv-jarvis' : h.role === 'tool' ? 'jv-tool done' : 'jv-error', h.text);
    stateEl.textContent = `voix : ${s.stt === 'gradium' ? 'Gradium' : 'navigateur'}`;
  }).catch(() => { orb.title = 'Jarvis indisponible sur cet hôte'; orb.style.opacity = '.4'; });
})();
