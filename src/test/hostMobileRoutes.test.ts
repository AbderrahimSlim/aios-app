/**
 * The phone app's HTTP side, on a real Gateway listening on loopback: what passes without pairing
 * (manifest, icons, and nothing else under them), where an unpaired /m is sent, the `next` of the
 * pairing round trip, and the CSP of /m. Section 4 of the 1136341 explainer listed these as untested.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Gateway } from '../host/gateway';
import type { PtyBridge } from '../host/ptyBridge';

const HOST = 'nucbox.test:8443';
const gw = new Gateway({ port: 0, bind: '127.0.0.1', home: fs.mkdtempSync(path.join(os.tmpdir(), 'aios-gw-')), platform: 'win32', version: '0.0.0' },
  { orphans: [] } as unknown as PtyBridge);
const ready = gw.start();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const server = (): http.Server => (gw as any).server;
after(() => { server().close(); server().closeAllConnections?.(); });

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
async function req(method: string, url: string, headers: Record<string, string> = {}, body = ''): Promise<Res> {
  await ready;
  const { port } = server().address() as { port: number };
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: HOST, ...headers } }, (res) => {
      let b = '';
      res.setEncoding('latin1');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const pairForm = (code: string, next: string) => new URLSearchParams({ code, next }).toString();
const POST = { origin: `https://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' };
const cookieOf = (r: Res) => String((r.headers['set-cookie'] || [])[0] || '').split(';')[0];

test('the manifest and the icons are served without pairing (iOS fetches them when installing)', async () => {
  const m = await req('GET', '/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.equal(m.headers['content-type'], 'application/manifest+json');
  assert.equal(JSON.parse(m.body).start_url, '/m');
  for (const size of [180, 192, 512]) {
    const i = await req('GET', `/web/icons/icon-${size}.png`);
    assert.equal(i.status, 200, `icon ${size}`);
    assert.equal(i.headers['content-type'], 'image/png');
    assert.equal(i.body.slice(1, 4), 'PNG');
  }
});

test('nothing else leaks through the icons route', async () => {
  for (const url of ['/web/icons/missing.png', '/web/icons/notes.txt', '/web/icons/%2e%2e%2fmobile.js', '/web/icons/..%2F..%2Fpackage.json', '/web/icons/']) {
    const r = await req('GET', url);
    assert.equal(r.status, 404, url);
    assert.equal(r.body, '', url);
  }
  // a plain ../ is resolved by the URL parser before routing, so it lands behind the device check
  const up = await req('GET', '/web/icons/../mobile.js');
  assert.equal(up.status, 302);
  assert.equal(up.headers.location, '/pair');
});

test('an unpaired /m goes to pairing and comes back to /m; every other page goes to plain /pair', async () => {
  const m = await req('GET', '/m');
  assert.equal(m.status, 302);
  assert.equal(m.headers.location, '/pair?next=%2Fm');
  const page = await req('GET', '/pair?next=%2Fm');
  assert.match(page.body, /name="next" value="\/m"/);
  const other = await req('GET', '/renderer/index.html');
  assert.equal(other.headers.location, '/pair');
  const evil = await req('GET', '/pair?next=https%3A%2F%2Fevil.example');
  assert.match(evil.body, /name="next" value="\/"/, 'a foreign next is dropped from the form');
});

test('pairing: a valid code redirects to a local next only, sets the cookie; a paired browser skips the form', async () => {
  const toEvil = await req('POST', '/pair', POST, pairForm(gw.store.newCode(), 'https://evil.example/steal'));
  assert.equal(toEvil.status, 303);
  assert.equal(toEvil.headers.location, '/', 'never off the host');

  const toM = await req('POST', '/pair', POST, pairForm(gw.store.newCode(), '/m'));
  assert.equal(toM.status, 303);
  assert.equal(toM.headers.location, '/m');
  const cookie = cookieOf(toM);
  assert.match(cookie, /^aios_host=/);
  assert.match(String(toM.headers['set-cookie']), /HttpOnly/);

  const again = await req('GET', '/pair?next=%2Fm', { cookie });
  assert.equal(again.status, 302);
  assert.equal(again.headers.location, '/m');

  // control: a pairing POST from another site is refused and the code is not spent
  const code = gw.store.newCode();
  const cross = await req('POST', '/pair', { ...POST, origin: 'https://evil.example' }, pairForm(code, '/m'));
  assert.equal(cross.status, 403);
  assert.equal((await req('POST', '/pair', POST, pairForm(code, '/m'))).status, 303);
});

test('/m, paired: its CSP lets the page reach this host\'s socket and nothing else, and renews the cookie', async () => {
  const cookie = cookieOf(await req('POST', '/pair', POST, pairForm(gw.store.newCode(), '/m')));
  const m = await req('GET', '/m', { cookie });
  assert.equal(m.status, 200);
  assert.ok(!m.body.includes('{{CONNECT}}'));
  assert.match(m.body, new RegExp(`connect-src 'self' wss://${HOST.replace('.', '\\.')} ws://${HOST.replace('.', '\\.')};`));
  assert.match(String(m.headers['set-cookie']), /^aios_host=.*Max-Age=31536000/);

  // a Host header that is not a plain host[:port] adds nothing to the CSP
  const odd = await req('GET', '/m', { cookie, host: 'nucbox.test:8443*' });
  assert.match(odd.body, /connect-src 'self';/);
});
