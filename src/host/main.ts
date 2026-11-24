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
  /* The desktop updater downloads and installs an app bundle: meaningless on a host (updated with git). */
  const { EventEmitter } = require('node:events');
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false, autoInstallOnAppQuit: false, logger: null,
    checkForUpdates: () => Promise.resolve(null), checkForUpdatesAndNotify: () => Promise.resolve(null),
    downloadUpdate: () => Promise.resolve([]), quitAndInstall: () => undefined, setFeedURL: () => undefined,
  });
  /* Every pty lives in the session supervisor, so a host restart never ends a session.
     AIOS_HOST_NO_SUPERVISOR=1 keeps ptys in this process (they then end with it). */
  const { PtyBridge } = await import('./ptyBridge');
  const bridge = new PtyBridge();
  const useSupervisor = process.env.AIOS_HOST_NO_SUPERVISOR !== '1';
  if (useSupervisor) {
    await bridge.connect();
    if (bridge.orphans.length) console.log(`[host] ${bridge.orphans.length} session(s) survived the restart; reopen them by name to take them back`);
  }
  const ptyModule = bridge.module();
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') return electronModule;
    if (request === 'electron-updater') return { autoUpdater: updater, default: { autoUpdater: updater } };
    if (request === 'node-pty' && useSupervisor) return ptyModule;
    return load.call(this, request, ...rest);
  };

  const port = Number(process.env.AIOS_HOST_PORT || 4800);
  const bind = process.env.AIOS_HOST_BIND || '127.0.0.1';
  const { Gateway } = await import('./gateway');
  const gw = new Gateway({ port, bind, home: HOST_HOME, platform: process.platform, version: app.getVersion() }, bridge);
  await gw.start();

  /* The unmodified main process: registers its ~150 IPC handlers, the command bus, the panel host. */
  require('../main/main');
  setImmediate(() => app.markReady());

  let jarvis: import('../jarvis/host').JarvisApi | undefined;
  /* Jarvis: the voice conductor (AIOS_JARVIS=0 to leave it off). */
  if (process.env.AIOS_JARVIS !== '0') {
    try {
      const { ipcMain, emitAll } = await import('./electronShim');
      const roots = (await ipcMain.handlers.get('fs:roots')?.({ sender: null })) as { framework?: string | null } | undefined;
      if (roots?.framework) {
        const { startJarvis } = await import('../jarvis/host');
        jarvis = startJarvis({
          hostHome: HOST_HOME, framework: roots.framework, broadcast: emitAll,
          listNodes: () => gw.nodes.list().map((n) => ({ id: n.id, machine: n.machine, capabilities: n.capabilities.length })),
          mcpServers: {
            'aios-nodes': {
              command: process.execPath,
              args: [path.join(__dirname, '..', 'jarvis', 'nodesMcp.js')],
              env: { AIOS_HOST_PORT: String(port), AIOS_INTERNAL_TOKEN_FILE: path.join(HOST_HOME, 'internal.token'), AIOS_SCREENS_DIR: path.join(roots.framework, 'vault', '02 - assets', 'generated', 'screens') },
            },
          },
        });
        const j = jarvis;
        gw.nodes.activeMachine = () => j.activeMachine();
        gw.nodes.onChange = () => j.nodesChanged();
      } else console.warn('[jarvis] not started: no AIOS framework found');
    } catch (e) { console.error('[jarvis] failed to start:', e); }
  }

  /* Phase 3: routines from the vault, the governor, and the memory distiller. */
  {
    const { ipcMain } = await import('./electronShim');
    const roots = (await ipcMain.handlers.get('fs:roots')?.({ sender: null })) as { framework?: string | null } | undefined;
    if (roots?.framework) {
      const framework = roots.framework;
      const { Scheduler, activity } = await import('./scheduler');
      const sched = new Scheduler({ framework, hostHome: HOST_HOME, isLive: (n) => gw.isLive(n), liveCount: (p) => gw.liveCount(p), askJarvis: jarvis ? (t) => jarvis!.ask(t) : undefined });
      if (process.env.AIOS_SCHEDULER !== '0') sched.start();
      const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(HOST_HOME, f), 'utf8')); } catch { return {}; } };
      const mem = readJson('memory.json');
      if (process.env.AIOS_MEMORY !== '0' && mem.enabled !== false) {
        const { Distiller } = await import('./distiller');
        new Distiller({ framework, hostHome: HOST_HOME, idleMinutes: Number(mem.idleMinutes) || 15, maxPerHour: Number(mem.maxPerHour) || 6, maxFiveHourPct: Number(mem.maxFiveHourPct) || 70 }).start();
      }
      /* Optional: keep a session named "jarvis-mobile" alive, to pick up from the Claude app (Remote Control). */
      if (readJson('jarvis.json').mobileSession === true) {
        const keep = () => {
          if (gw.isLive('jarvis-mobile') || sched.blocked()) return;
          const inbox = path.join(path.dirname(HOST_HOME), 'spawn-inbox');
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
          fs.writeFileSync(path.join(inbox, `${stamp}-jarvis-mobile.json`), JSON.stringify({ name: 'jarvis-mobile', task: "Tu es la session mobile de Jarvis : l'opérateur te rejoint depuis l'app Claude (Remote Control). Lis USER.md, puis attends ses messages.", tier: 'scale', effort: 'medium' }));
          activity(HOST_HOME, 'bus', 'session « jarvis-mobile » relancée pour l’app Claude');
        };
        setTimeout(keep, 60_000);
        setInterval(keep, 5 * 60_000).unref();
      }
    }
  }

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
