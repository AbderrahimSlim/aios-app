/* JARVIS in aios-host: the conductor, the voice engines and the page, wired over the same IPC surface
   the rest of the App uses (ipcMain handlers in, `jarvis:*` events out).

   "Sound follows you": the device that spoke or typed last is the ACTIVE one; only it receives audio
   (or, with the browser engine, the text to speak). Every connected device sees the transcript and the
   activity feed. Barge-in: when the operator starts speaking while Jarvis talks, the speech is cut and
   the turn interrupted; a stop word ("stop", "tais-toi", …) only interrupts. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcMain, FakeWebContents } from '../host/electronShim';
import { Conductor, ConductorEvent } from './conductor';
import { Speaker } from './speech';
import { DEFAULT_VOICE, GradiumStt, GradiumTts, VoiceConfig } from './voice';
import { ensureWorkspace } from './workspace';
import { readActivity } from '../host/scheduler';

const STOP_WORDS = /^\s*(stop|stoppe|arr[êe]te(-toi)?|annule|tais[- ]toi|silence|chut|cancel|shut up)\b[\s.!]*$/i;

interface Entry { role: 'user' | 'jarvis' | 'tool' | 'error'; text: string; at: number; }

export function loadVoiceConfig(hostHome: string): VoiceConfig {
  let file: Partial<VoiceConfig> = {};
  try { file = JSON.parse(fs.readFileSync(path.join(hostHome, 'jarvis.json'), 'utf8')); } catch { /* defaults */ }
  const cfg: VoiceConfig = { ...DEFAULT_VOICE, ...file };
  cfg.apiKey = process.env.GRADIUM_API_KEY || file.apiKey;
  /* Gradium is the default engine when a key exists; without one, the browser's own engine. */
  if (!file.stt) cfg.stt = cfg.apiKey ? 'gradium' : 'browser';
  if (!file.tts) cfg.tts = cfg.apiKey ? 'gradium' : 'browser';
  if (!cfg.apiKey) { cfg.stt = 'browser'; cfg.tts = 'browser'; }
  return cfg;
}

export interface JarvisApi { ask(text: string): void; activeMachine(): string | null; nodesChanged(): void; }

export function startJarvis(opts: { hostHome: string; framework: string; broadcast: (ch: string, a: unknown[]) => void; mcpServers?: Record<string, unknown>; listNodes?: () => unknown[] }): JarvisApi {
  const guardScript = path.join(__dirname, 'guard.js');
  const ws = ensureWorkspace(opts.hostHome, opts.framework, guardScript, process.execPath, opts.mcpServers || {});
  const voice = loadVoiceConfig(opts.hostHome);
  const conductor = new Conductor({ workspace: ws.dir, addDirs: [opts.framework, ws.roots[2]], stateFile: ws.stateFile, mcpConfig: ws.mcpConfig });
  const history: Entry[] = [];
  let active: FakeWebContents | null = null;
  let speaker = new Speaker();
  let tts: GradiumTts | null = null;
  let reply = '';
  const mics = new Map<FakeWebContents, GradiumStt>();
  /* Which machine each page runs on (chosen in the Jarvis panel): node calls go to the active one. */
  const machineOf = new Map<FakeWebContents, string>();

  const note = (e: Entry) => { history.push(e); if (history.length > 200) history.shift(); };
  const toAll = (ev: Record<string, unknown>) => opts.broadcast('jarvis:event', [ev]);
  const toActive = (ch: string, payload: unknown) => { if (active && !active.isDestroyed()) active.send(ch, payload); };

  const speak = (chunks: string[]) => {
    for (const c of chunks) {
      if (voice.tts === 'gradium') {
        if (!tts) {
          const t = new GradiumTts(voice);
          tts = t;
          t.on('audio', (b64: string, rate: number) => toActive('jarvis:audio', { b64, rate }));
          t.on('error', (m: string) => toAll({ type: 'error', text: `TTS : ${m}` }));
          t.on('done', () => { if (tts === t) tts = null; });
        }
        tts.say(c);
      } else toActive('jarvis:speak', { text: c, lang: voice.language });
    }
  };
  const shutUp = () => {
    if (tts) { tts.cancel(); tts = null; }
    speaker = new Speaker();
    toActive('jarvis:clearAudio', {});
  };

  conductor.on('event', (e: ConductorEvent) => {
    switch (e.type) {
      case 'turn_start': reply = ''; speaker = new Speaker(); toAll({ type: 'turn_start' }); return;
      case 'text': reply += e.delta; toAll({ type: 'delta', text: e.delta }); speak(speaker.push(e.delta)); return;
      case 'tool': note({ role: 'tool', text: e.summary, at: Date.now() }); toAll({ type: 'tool', id: e.id, text: e.summary }); return;
      case 'tool_done': toAll({ type: 'tool_done', id: e.id, ok: e.ok }); return;
      case 'turn_done':
        speak(speaker.flush());
        if (tts) tts.end();
        if (reply.trim()) note({ role: 'jarvis', text: reply.trim(), at: Date.now() });
        if (e.error) note({ role: 'error', text: e.error, at: Date.now() });
        toAll({ type: 'turn_done', error: e.error, costUsd: e.costUsd, ms: e.ms });
        return;
      case 'status': toAll({ type: 'status', state: e.state, detail: e.detail }); return;
    }
  });

  const utter = (sender: FakeWebContents, text: string) => {
    active = sender;
    if (STOP_WORDS.test(text)) { shutUp(); conductor.interrupt(); toAll({ type: 'interrupted' }); return; }
    if (conductor.isBusy) { shutUp(); conductor.interrupt(); }
    note({ role: 'user', text, at: Date.now() });
    toAll({ type: 'user', text });
    conductor.send(text);
  };

  /* "While you were away": what happened since this device last looked (routines, memory, bus). */
  ipcMain.handle('jarvis:state', (_e: unknown, since?: number) => ({
    stt: voice.stt, tts: voice.tts, language: voice.language, busy: conductor.isBusy, history: history.slice(-60),
    away: typeof since === 'number' && since > 0 ? readActivity(opts.hostHome, since).slice(-30) : [],
  }));
  ipcMain.handle('jarvis:say', (e: { sender: FakeWebContents }, text: string) => { utter(e.sender, String(text || '').slice(0, 8000)); return true; });
  ipcMain.handle('jarvis:interrupt', (e: { sender: FakeWebContents }) => { active = e.sender; shutUp(); conductor.interrupt(); return true; });
  ipcMain.handle('jarvis:setMachine', (e: { sender: FakeWebContents }, machine: string) => {
    const m = String(machine || '').slice(0, 64);
    if (m) machineOf.set(e.sender, m); else machineOf.delete(e.sender);
    e.sender.once('destroyed', () => machineOf.delete(e.sender));
    return true;
  });
  ipcMain.handle('jarvis:nodes', () => (opts.listNodes ? opts.listNodes() : []));
  ipcMain.handle('jarvis:reset', () => { shutUp(); conductor.reset(); history.length = 0; toAll({ type: 'reset' }); return true; });

  /* Microphone (gradium engine): the page streams 24 kHz PCM; the host recognises it. */
  ipcMain.on('jarvis:micStart', (e: { sender: FakeWebContents }) => {
    if (voice.stt !== 'gradium' || mics.has(e.sender)) return;
    active = e.sender;
    const stt = new GradiumStt(voice);
    mics.set(e.sender, stt);
    stt.on('speech', () => { if (tts || conductor.isBusy) { shutUp(); } e.sender.send('jarvis:event', { type: 'listening' }); });
    stt.on('partial', (t: string) => e.sender.send('jarvis:event', { type: 'partial', text: t }));
    stt.on('final', (t: string) => utter(e.sender, t));
    stt.on('error', (m: string) => e.sender.send('jarvis:event', { type: 'error', text: `STT : ${m}` }));
    e.sender.once('destroyed', () => { stt.close(); mics.delete(e.sender); });
  });
  ipcMain.on('jarvis:mic', (e: { sender: FakeWebContents }, b64: string) => { mics.get(e.sender)?.audio(String(b64)); });
  ipcMain.on('jarvis:micStop', (e: { sender: FakeWebContents }) => { mics.get(e.sender)?.close(); mics.delete(e.sender); });

  const api: JarvisApi = {
    /* A routine or the host speaks to Jarvis: the answer goes to whichever device is active. */
    ask(text: string) { note({ role: 'user', text, at: Date.now() }); toAll({ type: 'user', text }); conductor.send(text); },
    activeMachine() { return active ? machineOf.get(active) || null : null; },
    nodesChanged() { toAll({ type: 'nodes' }); },
  };
  console.log(`[jarvis] ready — stt ${voice.stt}, tts ${voice.tts}, workspace ${ws.dir}`);
  return api;
}
