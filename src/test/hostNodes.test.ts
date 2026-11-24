/** Host phase 4: the node broker (RFC §5.5) — schema checks, routing, delivery states. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkArgs, NodeBroker } from '../host/nodes';

class FakeWs extends EventEmitter {
  sent: any[] = [];
  closed = false;
  send(s: string): void { this.sent.push(JSON.parse(s)); }
  close(): void { this.closed = true; this.emit('close'); }
}
const caps = [
  { name: 'volume.set', description: '', schema: { type: 'object', properties: { level: { type: 'integer', minimum: 0, maximum: 100 } }, additionalProperties: false }, repeatable: true },
  { name: 'url.open', description: '', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];
function node(b: NodeBroker, id: string, machine: string): FakeWs {
  const ws = new FakeWs();
  b.attach(ws as any, id, machine);
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'register', machine, capabilities: caps })), false);
  return ws;
}
const tick = () => new Promise((r) => setImmediate(r));

test('checkArgs: types, bounds, required, unknown keys', () => {
  const s = caps[0].schema;
  assert.equal(checkArgs(s, { level: 30 }), null);
  assert.match(String(checkArgs(s, { level: 101 })), /range/);
  assert.match(String(checkArgs(s, { level: 3.5 })), /integer/);
  assert.match(String(checkArgs(s, { cmd: 'rm' })), /unknown/);
  assert.match(String(checkArgs(caps[1].schema, {})), /missing/);
});

test('routing: the active machine, else the only node, else ask which', async () => {
  const b = new NodeBroker();
  const a = node(b, 'n1', 'BUREAU');
  const p1 = b.call('volume.set', { level: 30 }, null);
  await tick();
  assert.equal(a.sent[0].cap, 'volume.set', 'only node online gets it');
  a.emit('message', Buffer.from(JSON.stringify({ t: 'result', id: a.sent[0].id, ok: true, value: { level: 30 } })), false);
  assert.deepEqual((await p1).value, { level: 30 });

  const c = node(b, 'n2', 'LAPTOP');
  const amb = await b.call('volume.set', { level: 10 }, null);
  assert.match(String(amb.error), /several nodes/);
  b.activeMachine = () => 'laptop';
  const p2 = b.call('volume.set', { level: 10 }, null);
  await tick();
  assert.equal(c.sent.length, 1, 'the machine of the active device');
  c.emit('message', Buffer.from(JSON.stringify({ t: 'result', id: c.sent[0].id, ok: true })), false);
  await p2;
  assert.match(String((await b.call('shell.exec', {}, null)).error), /LAPTOP does not offer shell\.exec/, 'the active machine lacks it: an answer at once');
  b.activeMachine = () => null;
  assert.match(String((await b.call('shell.exec', {}, null)).error), /no online node offers/);
  assert.match(String((await b.call('volume.set', { level: 500 }, 'BUREAU')).error), /range/);
});

test('a node dropping mid-call: repeatable is queued again, anything else is outcome unknown', async () => {
  const b = new NodeBroker();
  const a = node(b, 'n1', 'BUREAU');
  const pv = b.call('volume.set', { level: 20 }, 'BUREAU');
  const pu = b.call('url.open', { url: 'https://example.com' }, 'BUREAU');
  await tick();
  a.close();
  const u = await pu;
  assert.equal(u.state, 'unknown');
  assert.equal(b.queue().find((q) => q.cap === 'volume.set')?.state, 'queued');
  const back = node(b, 'n1', 'BUREAU');
  await tick();
  assert.equal(back.sent[0]?.cap, 'volume.set', 'redelivered when the node comes back');
  back.emit('message', Buffer.from(JSON.stringify({ t: 'result', id: back.sent[0].id, ok: true })), false);
  assert.equal((await pv).ok, true);
});

test('a machine remembered by the panel but offline falls back to the only node online (review finding)', async () => {
  const b = new NodeBroker();
  const a = node(b, 'n1', 'BUREAU');
  b.activeMachine = () => 'OLD-PC';
  const p = b.call('volume.set', { level: 5 }, null);
  await tick();
  assert.equal(a.sent[0]?.cap, 'volume.set');
  a.emit('message', Buffer.from(JSON.stringify({ t: 'result', id: a.sent[0].id, ok: true })), false);
  assert.equal((await p).ok, true);
});

test('revoking a node closes its socket (review finding)', () => {
  const b = new NodeBroker();
  const a = node(b, 'n1', 'BUREAU');
  node(b, 'n2', 'LAPTOP');
  b.dropMissing(new Set(['n2']));
  assert.equal(a.closed, true);
  assert.deepEqual(b.list().map((n) => n.machine), ['LAPTOP']);
});

test('cancel only while queued', async () => {
  const b = new NodeBroker();
  const p = b.call('volume.set', { level: 1 }, 'OFFLINE');
  const id = b.queue()[0].id;
  assert.equal(b.cancel(id), true);
  assert.equal((await p).state, 'cancelled');
});
