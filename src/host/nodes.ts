/* aios-host NODE BROKER (plan phase 4; docs/rfcs/cloud-mode.md §5.5).

   A node is a machine the operator wants to act on (a Windows workstation running jarvis-node). It pairs
   with the role `node`, connects OUTBOUND to the host (no open port on the PC), and declares capabilities,
   each with a JSON schema: volume.set, app.open, screen.capture… The host can only ask for a declared
   capability with arguments that fit its schema; it can never run an arbitrary command on a node.

   Delivery: a request is queued → leased (sent to a node) → done | failed | cancelled | unknown.
   It has a deadline; one still queued at its deadline fails visibly. If the node drops while running,
   a `repeatable` capability is queued again; any other becomes `unknown` and is never retried.

   WHERE: a request names a target (node id or machine name). Without one it goes to the machine of the
   device the operator spoke from (the Jarvis panel says which machine it runs on); with exactly one node
   online, to that one; otherwise it fails and lists the nodes. The host is never a target by default. */
import * as crypto from 'node:crypto';
import { WebSocket } from 'ws';

export interface Capability { name: string; description: string; schema: Record<string, unknown>; repeatable?: boolean; confirm?: boolean; }
interface NodeConn { id: string; deviceId: string; machine: string; caps: Capability[]; ws: WebSocket; connectedAt: number; }
type State = 'queued' | 'leased' | 'done' | 'failed' | 'cancelled' | 'unknown';
interface Req {
  id: string; cap: string; args: Record<string, unknown>; target: string | null; state: State; node?: string;
  createdAt: number; deadline: number; result?: unknown; error?: string;
  resolve: (r: { ok: boolean; value?: unknown; error?: string; state: State; node?: string }) => void;
}

const MAX_ARGS_BYTES = 64 * 1024;

/** A small JSON-schema check: type object, required keys, primitive types, enums, string length, number bounds. */
export function checkArgs(schema: Record<string, any>, args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const a = args as Record<string, unknown>;
  const props = (schema && schema.properties) || {};
  for (const k of schema?.required || []) if (!(k in a)) return `missing argument "${k}"`;
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) { if (schema?.additionalProperties === false) return `unknown argument "${k}"`; continue; }
    const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const want = p.type === 'integer' ? 'number' : p.type;
    if (want && t !== want) return `argument "${k}" must be ${p.type}`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `argument "${k}" must be an integer`;
    if (p.enum && !p.enum.includes(v)) return `argument "${k}" must be one of ${p.enum.join(', ')}`;
    if (typeof v === 'number' && ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum))) return `argument "${k}" out of range`;
    if (typeof v === 'string' && p.maxLength !== undefined && v.length > p.maxLength) return `argument "${k}" too long`;
  }
  return null;
}

export class NodeBroker {
  private readonly nodes = new Map<string, NodeConn>();
  private readonly reqs = new Map<string, Req>();
  /** The machine of the device the operator last spoke from (set by the Jarvis panel). */
  activeMachine: () => string | null = () => null;
  onChange: () => void = () => undefined;

  constructor() { setInterval(() => this.expire(), 1000).unref(); }

  list(): Array<{ id: string; machine: string; capabilities: Capability[]; since: number }> {
    return [...this.nodes.values()].map((n) => ({ id: n.id, machine: n.machine, capabilities: n.caps, since: n.connectedAt }));
  }

  queue(): Array<{ id: string; cap: string; target: string | null; state: State; node?: string; deadline: number }> {
    return [...this.reqs.values()].map((r) => ({ id: r.id, cap: r.cap, target: r.target, state: r.state, node: r.node, deadline: r.deadline }));
  }

  /** A node's socket, after auth. */
  attach(ws: WebSocket, deviceId: string, deviceName: string): void {
    const conn: NodeConn = { id: deviceId, deviceId, machine: deviceName, caps: [], ws, connectedAt: Date.now() };
    ws.on('message', (raw, bin) => {
      if (bin) { ws.close(1003, 'text only'); return; }
      let m: Record<string, any>;
      try { m = JSON.parse(String(raw)); } catch { ws.close(1008, 'bad json'); return; }
      if (m.t === 'register') {
        conn.machine = String(m.machine || deviceName).slice(0, 64);
        conn.caps = (Array.isArray(m.capabilities) ? m.capabilities : []).slice(0, 200)
          .filter((c: any) => c && typeof c.name === 'string' && /^[a-z][a-z0-9_.-]{1,63}$/.test(c.name))
          .map((c: any) => ({ name: c.name, description: String(c.description || '').slice(0, 300), schema: c.schema && typeof c.schema === 'object' ? c.schema : { type: 'object' }, repeatable: !!c.repeatable, confirm: !!c.confirm }));
        const old = this.nodes.get(conn.id);
        if (old && old.ws !== ws) old.ws.close(4003, 'replaced');
        this.nodes.set(conn.id, conn);
        console.log(`[nodes] ${conn.machine} online with ${conn.caps.length} capabilities`);
        this.onChange();
        this.pump();
        return;
      }
      const r = typeof m.id === 'string' ? this.reqs.get(m.id) : undefined;
      if (!r || r.node !== conn.id || r.state !== 'leased') return;
      if (m.t === 'result') {
        r.state = m.ok ? 'done' : 'failed';
        this.finish(r, { ok: !!m.ok, value: m.value, error: m.ok ? undefined : String(m.error || 'failed') });
      }
    });
    ws.on('close', () => {
      if (this.nodes.get(conn.id)?.ws !== ws) return;
      this.nodes.delete(conn.id);
      console.log(`[nodes] ${conn.machine} offline`);
      for (const r of this.reqs.values()) {
        if (r.node !== conn.id || r.state !== 'leased') continue;
        const cap = conn.caps.find((c) => c.name === r.cap);
        if (cap?.repeatable) { r.state = 'queued'; r.node = undefined; }
        else { r.state = 'unknown'; this.finish(r, { ok: false, error: `${conn.machine} disconnected while running ${r.cap}: outcome unknown, not retried` }); }
      }
      this.onChange();
    });
  }

  private resolveNode(r: Req): NodeConn | { error: string } | null {
    const online = [...this.nodes.values()].filter((n) => n.caps.some((c) => c.name === r.cap));
    const want = r.target || this.activeMachine();
    if (want) {
      const hit = [...this.nodes.values()].find((n) => n.id === want || n.machine.toLowerCase() === want.toLowerCase());
      if (!hit) return null;                                  // that node is offline: wait for it
      if (!hit.caps.some((c) => c.name === r.cap)) return { error: `${hit.machine} does not offer ${r.cap}` };
      return hit;
    }
    if (online.length === 1) return online[0];
    /* Wait only when NO node is online (one may come); nodes online without it is an answer now. */
    if (online.length === 0) return this.nodes.size ? { error: `no online node offers ${r.cap}` } : null;
    return { error: `several nodes offer ${r.cap} (${online.map((n) => n.machine).join(', ')}): say which one` };
  }

  call(cap: string, args: Record<string, unknown>, target: string | null, timeoutMs = 120_000): Promise<{ ok: boolean; value?: unknown; error?: string; state: State; node?: string }> {
    return new Promise((resolve) => {
      if (JSON.stringify(args || {}).length > MAX_ARGS_BYTES) { resolve({ ok: false, error: 'arguments too large', state: 'failed' }); return; }
      const r: Req = { id: crypto.randomBytes(8).toString('hex'), cap, args: args || {}, target, state: 'queued', createdAt: Date.now(), deadline: Date.now() + Math.min(Math.max(timeoutMs, 5000), 600_000), resolve };
      this.reqs.set(r.id, r);
      this.pump();
      this.onChange();
    });
  }

  cancel(id: string): boolean {
    const r = this.reqs.get(id);
    if (!r || r.state !== 'queued') return false;            // cancellation is guaranteed only while queued
    r.state = 'cancelled';
    this.finish(r, { ok: false, error: 'cancelled' });
    return true;
  }

  private pump(): void {
    for (const r of this.reqs.values()) {
      if (r.state !== 'queued') continue;
      const n = this.resolveNode(r);
      if (!n) continue;
      if ('error' in n) { r.state = 'failed'; this.finish(r, { ok: false, error: n.error }); continue; }
      const cap = n.caps.find((c) => c.name === r.cap)!;
      const bad = checkArgs(cap.schema as Record<string, any>, r.args);
      if (bad) { r.state = 'failed'; this.finish(r, { ok: false, error: bad }); continue; }
      r.state = 'leased'; r.node = n.id;
      n.ws.send(JSON.stringify({ t: 'call', id: r.id, cap: r.cap, args: r.args, deadline: r.deadline }));
    }
  }

  private expire(): void {
    const now = Date.now();
    for (const r of this.reqs.values()) {
      if (r.state === 'queued' && now > r.deadline) { r.state = 'failed'; this.finish(r, { ok: false, error: r.target ? `${r.target} did not come online in time` : 'no suitable node online in time' }); }
      else if (r.state === 'leased' && now > r.deadline + 30_000) { r.state = 'unknown'; this.finish(r, { ok: false, error: 'no answer from the node: outcome unknown' }); }
    }
    for (const [id, r] of this.reqs) if (!['queued', 'leased'].includes(r.state) && now - r.createdAt > 3600_000) this.reqs.delete(id);
  }

  private finish(r: Req, out: { ok: boolean; value?: unknown; error?: string }): void {
    const node = r.node ? this.nodes.get(r.node)?.machine : undefined;
    r.result = out.value; r.error = out.error;
    r.resolve({ ...out, state: r.state, node });
    this.onChange();
  }
}
