/* aios-host — the AIOS App's main process, headless, served to browsers (docs/rfcs/cloud-mode.md).

   USAGE  (after `npm run compile`; `npm run host -- <cmd>` compiles first)
     node out/host/main.js                 start the host (default 127.0.0.1:4800)
     node out/host/main.js pair            print a one-time pairing code (10 min) for a new device
     node out/host/main.js devices         list paired devices
     node out/host/main.js revoke <id>     revoke a device (its open connections close within seconds)

   ENV   AIOS_HOST_PORT (4800) · AIOS_HOST_BIND (127.0.0.1) · AIOS_HOST_HOME (~/.aios/host) · AIOS_HOST_DEBUG=1

   Remote access: keep the loopback bind and publish it on your tailnet with TLS, e.g.
     tailscale serve --bg --https=443 http://127.0.0.1:4800
   A browser only grants the microphone on https or localhost, so TLS is not optional for voice. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, electronModule, HOST_HOME } from './electronShim';
import { DeviceStore } from './auth';

const cmd = process.argv[2] || 'start';
const store = new DeviceStore(HOST_HOME);

function lockOrExit(): void {
  fs.mkdirSync(HOST_HOME, { recursive: true });
  const lock = path.join(HOST_HOME, 'host.pid');
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); console.error(`aios-host already running (pid ${pid}).`); process.exit(1); } catch { /* stale lock */ }
    }
  } catch { /* no lock */ }
  fs.writeFileSync(lock, String(process.pid));
  process.on('exit', () => { try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock); } catch { /* gone */ } });
}

async function start(): Promise<void> {
  lockOrExit();
  /* Every `require('electron')` in the main process resolves to the host stand-in. */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') return electronModule;
    return load.call(this, request, ...rest);
  };

  const port = Number(process.env.AIOS_HOST_PORT || 4800);
  const bind = process.env.AIOS_HOST_BIND || '127.0.0.1';
  const { Gateway } = await import('./gateway');
  const gw = new Gateway({ port, bind, home: HOST_HOME, platform: process.platform, version: app.getVersion() });
  await gw.start();

  /* The unmodified main process: registers its ~150 IPC handlers, the command bus, the panel host. */
  require('../main/main');
  setImmediate(() => app.markReady());

  const loop = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
  console.log(`aios-host ${app.getVersion()} — http://${loop ? '127.0.0.1' : bind}:${port}/`);
  if (!loop) console.warn('WARNING: listening beyond loopback without TLS. Prefer the loopback bind behind `tailscale serve`.');
  if (store.list().length === 0) console.log(`No device paired yet. Pairing code (10 min): ${store.newCode()}`);

  const stop = () => app.quit();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

switch (cmd) {
  case 'start':
    start().catch((e) => { console.error('aios-host failed to start:', e); process.exit(1); });
    break;
  case 'pair':
    console.log(`Pairing code (10 min, single use): ${store.newCode()}`);
    break;
  case 'devices':
    for (const d of store.list()) console.log(`${d.id}  ${new Date(d.lastSeen).toISOString()}  ${d.name}`);
    break;
  case 'revoke':
    console.log(store.revoke(process.argv[3] || '') ? 'revoked' : 'no such device');
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
}
