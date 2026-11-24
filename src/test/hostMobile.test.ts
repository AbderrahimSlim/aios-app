/** Host mode — the phone app (/m): pairing's return page and the session list. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listSessions, safeHost, safeNext } from '../host/mobile';

test('mobile: pairing returns only to a known page, never to a URL from the request', () => {
  assert.equal(safeNext('/m'), '/m');
  assert.equal(safeNext('/'), '/');
  for (const bad of ['https://evil.example', '//evil.example', '/m/../x', '/renderer/index.html', '', null, undefined, ['/m']]) {
    assert.equal(safeNext(bad), '/', String(bad));
  }
});

test('mobile: only a plain host[:port] reaches the page CSP', () => {
  assert.equal(safeHost('box.tail1234.ts.net:8443'), 'box.tail1234.ts.net:8443');
  assert.equal(safeHost('127.0.0.1:4800'), '127.0.0.1:4800');
  assert.equal(safeHost("x; script-src 'unsafe-inline'"), null);
  assert.equal(safeHost('a b'), null);
  assert.equal(safeHost(undefined), null);
});

test('mobile: sessions come from the registry, dead processes and broken files skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-sessions-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: 1, name: 'Wall-E', status: 'busy', cwd: 'C:\\Users\\me\\aios\\', updatedAt: 200, kind: 'interactive', formerNames: [{ name: 'aios', until: 1 }], sessionId: 'cc7a0684-0962-4032-930c-bd6b16ecb90b' }));
  fs.writeFileSync(path.join(dir, '6.json'), JSON.stringify({ pid: 6, name: 'jarvis-18', status: 'idle', entrypoint: 'sdk-cli', updatedAt: 400 }));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: 2, name: 'old', status: 'idle', cwd: '/home/me/crm', updatedAt: 100 }));
  fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ pid: 3, name: 'gone', status: 'busy', updatedAt: 300 }));
  fs.writeFileSync(path.join(dir, '4.json'), '{"pid": ');
  fs.writeFileSync(path.join(dir, '5.key'), 'secret');
  const rows = listSessions(dir, (pid) => pid !== 3);
  assert.deepEqual(rows.map((r) => r.name), ['Wall-E', 'old'], 'an SDK session (Jarvis) is not a conversation');
  assert.equal(rows[0].status, 'busy');
  assert.deepEqual(rows[0].aliases, ['aios'], 'a renamed session keeps the name its terminal was launched with');
  assert.equal(rows[0].sessionId, 'cc7a0684-0962-4032-930c-bd6b16ecb90b');
  assert.equal(rows[1].sessionId, '', 'no id, no transcript to follow');
  assert.equal(rows[0].folder, 'aios');
  assert.equal(rows[1].folder, 'crm');
  assert.deepEqual(listSessions(path.join(dir, 'missing')), []);
});
