/** Host mode (docs/rfcs/cloud-mode.md): the wire protocol and device pairing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { asClientMsg, decode, encode } from '../host/protocol';
import { DeviceStore, parseCookies } from '../host/auth';

test('protocol: binary values survive the trip as ArrayBuffer', () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  const back = decode(encode({ t: 'invoke', id: 1, ch: 'chatFiles:savePastedImage', a: [bytes.buffer, 'image/png'] })) as { a: unknown[] };
  assert.ok(back.a[0] instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(back.a[0] as ArrayBuffer)], [0, 1, 2, 254, 255]);
  const buf = decode(encode({ t: 'ev', ch: 'x', a: [Buffer.from('hi')], s: 1 })) as { a: unknown[] };
  assert.equal(Buffer.from(buf.a[0] as ArrayBuffer).toString(), 'hi');
});

test('protocol: only well-formed client messages are accepted', () => {
  assert.deepEqual(asClientMsg({ t: 'hello', v: 1 }), { t: 'hello', v: 1 });
  assert.ok(asClientMsg({ t: 'invoke', id: 3, ch: 'fs:roots', a: [] }));
  assert.ok(asClientMsg({ t: 'send', ch: 'pty:write', a: [{ id: 1, data: 'x' }] }));
  assert.equal(asClientMsg({ t: 'invoke', id: 1.5, ch: 'fs:roots', a: [] }), null);
  assert.equal(asClientMsg({ t: 'invoke', id: 1, ch: '../evil', a: [] }), null);
  assert.equal(asClientMsg({ t: 'invoke', id: 1, ch: 'x'.repeat(65), a: [] }), null);
  assert.equal(asClientMsg({ t: 'send', ch: 'pty:write', a: 'not a list' }), null);
  assert.equal(asClientMsg({ t: 'eval', code: '1' }), null);
  assert.equal(asClientMsg(null), null);
});

test('pairing: a code works once, issues a verifiable device, and revocation ends it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-host-'));
  const s = new DeviceStore(home);
  const code = s.newCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const cookie = s.pair(code.toLowerCase(), 'test-browser');
  assert.ok(cookie);
  assert.equal(s.pair(code, 'again'), null, 'single use');
  const d = s.verify(cookie as string);
  assert.equal(d?.name, 'test-browser');
  assert.equal(s.verify((cookie as string).replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))), null, 'a forged secret fails');
  assert.ok(!fs.readFileSync(path.join(home, 'devices.json'), 'utf8').includes((cookie as string).split('.')[1]), 'only the hash is stored');
  assert.equal(s.revoke(d!.id), true);
  assert.equal(s.verify(cookie as string), null);
});

test('pairing: five wrong codes lock pairing, even for a valid code', () => {
  const s = new DeviceStore(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-host-')));
  const good = s.newCode();
  for (let i = 0; i < 5; i++) assert.equal(s.pair('ZZZZ-ZZZZ', 'guess'), null);
  assert.equal(s.locked(), true);
  assert.equal(s.pair(good, 'late'), null);
});

test('cookies parse', () => {
  assert.deepEqual(parseCookies('a=1; aios_host=ab.cd%3D; b'), { a: '1', aios_host: 'ab.cd=' });
});
