/* HOST MODE — the wire protocol between a browser client and aios-host (docs/rfcs/cloud-mode.md §5.2).

   It is the IPC surface, lifted: every `ipcRenderer.invoke` becomes an `invoke` request answered by
   `res`, every `ipcRenderer.send` a `send`, every `webContents.send` an `ev` event. Events carry a
   sequence number and the host's epoch (new on every host start), so a client can tell a gap or a
   restart from silence. Binary values (an ArrayBuffer of pasted image bytes, a Buffer) travel as
   `{ __b64 }` and are turned back into the same kind on the other side. */

export const PROTOCOL_VERSION = 1;

export type ClientMsg =
  | { t: 'hello'; v: number }
  | { t: 'invoke'; id: number; ch: string; a: unknown[] }
  | { t: 'send'; ch: string; a: unknown[] };

export type HostMsg =
  | { t: 'welcome'; v: number; epoch: string; platform: string; version: string }
  | { t: 'res'; id: number; ok: true; v: unknown }
  | { t: 'res'; id: number; ok: false; e: string }
  | { t: 'ev'; ch: string; a: unknown[]; s: number }
  | { t: 'bye'; reason: string };

/** Limits on what one client may send (RFC §7 "validation and limits"). */
export const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxInflight: 256, maxChannelLen: 64 };

function toB64(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return { __b64: Buffer.from(v).toString('base64') };
  if (ArrayBuffer.isView(v)) return { __b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  return v;
}

export function encode(msg: HostMsg | ClientMsg): string {
  return JSON.stringify(msg, function (this: unknown, _k, v) {
    /* JSON.stringify calls Buffer#toJSON before the replacer sees it. */
    if (v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer' && Array.isArray((v as { data?: unknown }).data)) {
      return { __b64: Buffer.from((v as { data: number[] }).data).toString('base64') };
    }
    return toB64(v);
  });
}

export function decode(raw: string): unknown {
  return JSON.parse(raw, (_k, v) => {
    if (v && typeof v === 'object' && typeof (v as { __b64?: unknown }).__b64 === 'string' && Object.keys(v).length === 1) {
      const b = Buffer.from((v as { __b64: string }).__b64, 'base64');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);   // the renderer sent an ArrayBuffer
    }
    return v;
  });
}

/** Shape check of a client message. Anything else closes the connection. */
export function asClientMsg(x: unknown): ClientMsg | null {
  if (!x || typeof x !== 'object') return null;
  const m = x as Record<string, unknown>;
  const chOk = (c: unknown) => typeof c === 'string' && c.length > 0 && c.length <= LIMITS.maxChannelLen && /^[A-Za-z0-9:_-]+$/.test(c);
  if (m.t === 'hello' && typeof m.v === 'number') return { t: 'hello', v: m.v };
  if (m.t === 'invoke' && Number.isInteger(m.id) && chOk(m.ch) && Array.isArray(m.a)) return { t: 'invoke', id: m.id as number, ch: m.ch as string, a: m.a };
  if (m.t === 'send' && chOk(m.ch) && Array.isArray(m.a)) return { t: 'send', ch: m.ch as string, a: m.a };
  return null;
}
