/* JARVIS — interchangeable voice engines.

   `gradium` (default when a key is configured): streaming STT and TTS over Gradium's WebSocket API
   (docs.gradium.ai), called from the host so the API key never reaches a browser.
   `browser`: the client's own Web Speech API (speech recognition + speechSynthesis), free, no key;
   the host then only exchanges text with the page.
   Local engines (faster-whisper + Piper) come with the Linux host (plan phase 5).

   STT end of turn follows jarvis-gradium-starter: Gradium reports, every 80 ms, the probability that
   the speaker has stopped; above `endOfTurn` for two steps in a row, the host asks for a flush and
   the flushed text is the operator's utterance. */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface VoiceConfig {
  stt: 'gradium' | 'browser';
  tts: 'gradium' | 'browser';
  apiKey?: string;
  language: string;            // 'fr', 'en', …
  voiceId: string;             // Gradium voice (default: Armand, French, masculine)
  endOfTurn: number;           // 0..1
  sttUrl: string;
  ttsUrl: string;
}

export const DEFAULT_VOICE: VoiceConfig = {
  stt: 'browser', tts: 'browser', language: 'fr', voiceId: 'F7Iib4MAyHIRed0x', endOfTurn: 0.8,
  sttUrl: 'wss://api.gradium.ai/api/speech/asr', ttsUrl: 'wss://api.gradium.ai/api/speech/tts',
};

/** Streaming recognition of one microphone session. Events: 'speech' (the operator started talking), 'partial' (text so far), 'final' (an utterance), 'error'. */
export class GradiumStt extends EventEmitter {
  private ws: WebSocket;
  private ready = false;
  private pending: string[] = [];
  private utterance = '';
  private above = 0;
  private flushId = 0;
  private flushing = false;
  private closed = false;

  constructor(private readonly cfg: VoiceConfig) {
    super();
    this.ws = this.open();
  }

  private open(): WebSocket {
    const ws = new WebSocket(this.cfg.sttUrl, { headers: { 'x-api-key': String(this.cfg.apiKey || '') } });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'setup', model_name: 'default', input_format: 'pcm', json_config: { language: this.cfg.language, delay_in_frames: 8 } })));
    ws.on('message', (raw) => {
      let m: Record<string, any>;
      try { m = JSON.parse(String(raw)); } catch { return; }
      switch (m.type) {
        case 'ready': this.ready = true; for (const a of this.pending) ws.send(a); this.pending = []; return;
        case 'text':
          if (!this.utterance) this.emit('speech');
          this.utterance += (this.utterance && !/^\s/.test(m.text) ? ' ' : '') + String(m.text || '');
          this.emit('partial', this.utterance.trim());
          this.above = 0;
          return;
        case 'step': {
          const vad = Array.isArray(m.vad) ? m.vad : [];
          const p = Number((vad[2] || vad[vad.length - 1] || {}).inactivity_prob || 0);
          this.above = p > this.cfg.endOfTurn ? this.above + 1 : 0;
          if (this.above >= 2 && this.utterance.trim() && !this.flushing) {
            this.flushing = true;
            ws.send(JSON.stringify({ type: 'flush', flush_id: ++this.flushId }));
          }
          return;
        }
        case 'flushed': {
          const text = this.utterance.trim();
          this.utterance = ''; this.flushing = false; this.above = 0;
          if (text) this.emit('final', text);
          return;
        }
        case 'error': this.emit('error', `${m.code || ''} ${m.message || 'STT error'}`.trim()); return;
      }
    });
    ws.on('close', () => {
      this.ready = false;
      /* Sessions are capped in length: reopen transparently while the mic is still on. */
      if (!this.closed) setTimeout(() => { if (!this.closed) this.ws = this.open(); }, 300);
    });
    ws.on('error', (e) => this.emit('error', String(e.message || e)));
    return ws;
  }

  /** 24 kHz s16le mono PCM, base64 (80 ms chunks recommended). */
  audio(b64: string): void {
    const msg = JSON.stringify({ type: 'audio', audio: b64 });
    if (this.ready && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else if (this.pending.length < 100) this.pending.push(msg);
  }

  close(): void {
    this.closed = true;
    try { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'end_of_stream' })); } catch { /* closing */ }
    setTimeout(() => { try { this.ws.close(); } catch { /* closed */ } }, 200);
  }
}

/** One spoken reply: text goes in as it is produced, PCM comes out. Events: 'audio' (base64 pcm, sampleRate), 'done', 'error'. */
export class GradiumTts extends EventEmitter {
  private ws: WebSocket;
  private ready = false;
  private pending: string[] = [];
  private cancelled = false;
  private sampleRate = 24000;

  constructor(cfg: VoiceConfig) {
    super();
    this.ws = new WebSocket(cfg.ttsUrl, { headers: { 'x-api-key': String(cfg.apiKey || '') } });
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'setup', model_name: 'default', voice_id: cfg.voiceId, output_format: 'pcm_24000', json_config: { rewrite_rules: cfg.language } })));
    this.ws.on('message', (raw) => {
      if (this.cancelled) return;
      let m: Record<string, any>;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'ready') { this.ready = true; this.sampleRate = Number(m.sample_rate) || 24000; for (const p of this.pending) this.ws.send(p); this.pending = []; }
      else if (m.type === 'audio' && m.audio) this.emit('audio', String(m.audio), this.sampleRate);
      else if (m.type === 'end_of_stream') { this.emit('done'); this.ws.close(); }
      else if (m.type === 'error') this.emit('error', `${m.code || ''} ${m.message || 'TTS error'}`.trim());
    });
    this.ws.on('error', (e) => this.emit('error', String(e.message || e)));
    this.ws.on('close', () => this.emit('done'));
  }

  private out(m: unknown): void {
    const s = JSON.stringify(m);
    if (this.ready && this.ws.readyState === WebSocket.OPEN) this.ws.send(s); else this.pending.push(s);
  }
  say(text: string): void { if (!this.cancelled && text.trim()) this.out({ type: 'text', text: text + ' ' }); }
  end(): void { if (!this.cancelled) this.out({ type: 'end_of_stream' }); }
  /** Barge-in: stop now. The API documents no "clear", so the socket is closed. */
  cancel(): void { this.cancelled = true; try { this.ws.close(); } catch { /* closed */ } }
}
