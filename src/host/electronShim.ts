/* HOST MODE — a stand-in for the `electron` module, so the unmodified main process (out/main/main.js)
   runs under plain Node on an always-on machine (docs/rfcs/cloud-mode.md §5.1: "extracted, not
   rewritten"). Only the surfaces the main process actually touches are modelled:

   - ipcMain        a real registry; the host's WebSocket gateway dispatches client requests into it.
   - BrowserWindow  a window with no pixels: its webContents.send() is broadcast to every connected
                    client, which is exactly what the renderer would have received over IPC.
   - app            lifecycle events, paths (userData under ~/.aios/host), version, locale.
   - everything     desktop-only (Tray, Menu, globalShortcut, powerSaveBlocker, Notification, protocol,
     else           nativeTheme, screen, dialog) is a harmless no-op or a fixed answer: there is no
                    desktop on a host, and a client keeps those capabilities local (RFC §5.4).

   Anything the main process reaches for that is NOT modelled resolves to an inert, callable proxy
   instead of throwing, and is logged once with AIOS_HOST_DEBUG=1, so a new upstream call degrades to a
   no-op rather than crashing the host. */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEBUG = process.env.AIOS_HOST_DEBUG === '1';
const warned = new Set<string>();
function note(what: string): void {
  if (!DEBUG || warned.has(what)) return;
  warned.add(what);
  console.log(`[host-shim] not modelled: ${what}`);
}

/** A callable, chainable no-op: any property is another inert proxy, any call returns one. */
function inert(name: string): any {
  const fn = function () { note(`${name}()`); return inert(`${name}()`); };
  return new Proxy(fn, {
    get(_t, k) {
      if (k === 'then') return undefined;              // never look like a promise
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () { /* empty */ };
      if (typeof k === 'symbol') return undefined;
      return inert(`${name}.${String(k)}`);
    },
  });
}

/** Wrap a module object so unknown members are inert instead of undefined. */
function tolerant<T extends object>(name: string, obj: T): T {
  return new Proxy(obj, {
    get(t, k, r) {
      if (k in t || typeof k === 'symbol') return Reflect.get(t, k, r);
      return inert(`${name}.${String(k)}`);
    },
  });
}

// ── the outbound side: whatever the main process sends to "the window" ─────────────────────────

export type Broadcast = (channel: string, args: unknown[]) => void;
let broadcast: Broadcast = () => undefined;
/** The gateway plugs itself in here; until then sends are dropped (no client can be listening). */
export function setBroadcast(fn: Broadcast): void { broadcast = fn; }

// ── ipcMain ────────────────────────────────────────────────────────────────────────────────────

type Handler = (event: unknown, ...args: unknown[]) => unknown;
class IpcMain extends EventEmitter {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, fn: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, fn);
  }
  handleOnce(channel: string, fn: Handler): void {
    this.handle(channel, (e, ...a) => { this.handlers.delete(channel); return fn(e, ...a); });
  }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
}
export const ipcMain = new IpcMain();
ipcMain.setMaxListeners(0);

// ── webContents / BrowserWindow ────────────────────────────────────────────────────────────────

let nextWcId = 1;
export class FakeWebContents extends EventEmitter {
  readonly id = nextWcId++;
  private destroyed = false;
  /** `sink` routes this contents' sends: the main window broadcasts to every client, a client's own
   *  contents (one per WebSocket connection) answers that client only, a secondary window has none. */
  constructor(private readonly primary: boolean, private readonly sink?: Broadcast) { super(); this.setMaxListeners(0); }
  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) return;
    if (this.sink) this.sink(channel, args);
    else if (this.primary) broadcast(channel, args);
  }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.emit('destroyed'); }
  isLoading(): boolean { return false; }
  getURL(): string { return 'aios-host://renderer/index.html'; }
  focus(): void { /* no pixels */ }
  setWindowOpenHandler(): void { /* no pixels */ }
  setZoomFactor(): void { /* client-side */ }
  getZoomFactor(): number { return 1; }
  openDevTools(): void { /* client-side */ }
  isDevToolsOpened(): boolean { return false; }
  executeJavaScript(): Promise<unknown> { return Promise.resolve(undefined); }
  capturePage(): Promise<unknown> { return Promise.resolve(nativeImage.createEmpty()); }
  get session(): unknown { return session.defaultSession; }
}

const windows: FakeBrowserWindow[] = [];
let primaryTaken = false;
export class FakeBrowserWindow extends EventEmitter {
  readonly webContents: FakeWebContents;
  readonly id: number;
  private destroyed = false;
  private visible: boolean;
  constructor(opts: { show?: boolean } = {}) {
    super();
    this.setMaxListeners(0);
    /* The first window the main process creates is its main window; later ones (quick bar, offscreen
       capture) are not the operator's screen. */
    this.webContents = new FakeWebContents(!primaryTaken);
    primaryTaken = true;
    this.id = this.webContents.id;
    this.visible = opts.show !== false;
    windows.push(this);
  }
  static getAllWindows(): FakeBrowserWindow[] { return windows.filter((w) => !w.destroyed); }
  static getFocusedWindow(): FakeBrowserWindow | null { return FakeBrowserWindow.getAllWindows()[0] ?? null; }
  static fromWebContents(wc: unknown): FakeBrowserWindow | null { return windows.find((w) => w.webContents === wc) ?? null; }
  loadFile(): Promise<void> { return Promise.resolve(); }
  loadURL(): Promise<void> { return Promise.resolve(); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.webContents.destroy(); this.emit('closed'); }
  close(): void { this.destroy(); }
  show(): void { this.visible = true; }
  showInactive(): void { this.visible = true; }
  hide(): void { this.visible = false; }
  focus(): void { /* no pixels */ }
  blur(): void { /* no pixels */ }
  isVisible(): boolean { return this.visible; }
  isFocused(): boolean { return this.visible; }
  isMinimized(): boolean { return false; }
  isMaximized(): boolean { return false; }
  isFullScreen(): boolean { return false; }
  setFullScreen(): void { /* no pixels */ }
  restore(): void { /* no pixels */ }
  minimize(): void { /* no pixels */ }
  maximize(): void { /* no pixels */ }
  setBounds(): void { /* no pixels */ }
  getBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 1360, height: 860 }; }
  getContentBounds(): { x: number; y: number; width: number; height: number } { return this.getBounds(); }
  getSize(): number[] { return [1360, 860]; }
  setSize(): void { /* no pixels */ }
  setPosition(): void { /* no pixels */ }
  getPosition(): number[] { return [0, 0]; }
  setAlwaysOnTop(): void { /* no pixels */ }
  setVisibleOnAllWorkspaces(): void { /* no pixels */ }
  setTitle(): void { /* no pixels */ }
  setMenuBarVisibility(): void { /* no pixels */ }
  setProgressBar(): void { /* no pixels */ }
  flashFrame(): void { /* no pixels */ }
  setSkipTaskbar(): void { /* no pixels */ }
  center(): void { /* no pixels */ }
}

// ── app ────────────────────────────────────────────────────────────────────────────────────────

export const HOST_HOME = process.env.AIOS_HOST_HOME || path.join(os.homedir(), '.aios', 'host');

function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

class App extends EventEmitter {
  /* The host IS the operator's surface, so it announces its presence on the bus like an installed App
     (commandBus gates that on isPackaged). The desktop auto-updater, the other isPackaged gate, is
     replaced by an inert stand-in in host/main.ts: a host is updated with git, not an installer.
     AIOS_HOST_DEV=1 behaves as a dev build (no presence), for a host beside a real installed App. */
  isPackaged = process.env.AIOS_HOST_DEV !== '1';
  private readonly paths: Record<string, string> = {
    home: os.homedir(),
    appData: HOST_HOME,
    userData: path.join(HOST_HOME, 'userData'),
    temp: os.tmpdir(),
    logs: path.join(HOST_HOME, 'logs'),
    downloads: path.join(os.homedir(), 'Downloads'),
    desktop: path.join(os.homedir(), 'Desktop'),
    documents: path.join(os.homedir(), 'Documents'),
  };
  private readyResolve!: () => void;
  private readonly ready = new Promise<void>((r) => { this.readyResolve = r; });
  private isReadyFlag = false;
  readonly dock = undefined;
  constructor() { super(); this.setMaxListeners(0); }
  /** Called by the host once the main process module has finished loading. */
  markReady(): void {
    if (this.isReadyFlag) return;
    this.isReadyFlag = true;
    this.readyResolve();
    this.emit('ready');
  }
  whenReady(): Promise<void> { return this.ready; }
  isReady(): boolean { return this.isReadyFlag; }
  getPath(name: string): string {
    const p = this.paths[name] ?? path.join(HOST_HOME, name);
    try { fs.mkdirSync(p, { recursive: true }); } catch { /* best effort */ }
    return p;
  }
  setPath(name: string, p: string): void { this.paths[name] = p; }
  getVersion(): string { return readVersion(); }
  getName(): string { return 'AIOS'; }
  getLocale(): string { return (process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || 'en').split('.')[0].replace('_', '-'); }
  getSystemLocale(): string { return this.getLocale(); }
  getPreferredSystemLanguages(): string[] { return [this.getLocale()]; }
  getAppPath(): string { return path.join(__dirname, '..', '..'); }
  requestSingleInstanceLock(): boolean { return true; }       // the host owns its own lock (server.ts)
  setAppUserModelId(): void { /* toast attribution: desktop only */ }
  setAboutPanelOptions(): void { /* desktop only */ }
  setLoginItemSettings(): void { /* desktop only */ }
  getLoginItemSettings(): { openAtLogin: boolean } { return { openAtLogin: false }; }
  focus(): void { /* no pixels */ }
  hide(): void { /* no pixels */ }
  show(): void { /* no pixels */ }
  quit(): void {
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('before-quit', e);
    if (e.defaultPrevented) return;
    this.emit('will-quit', e);
    if (e.defaultPrevented) return;
    this.emit('quit');
    setImmediate(() => process.exit(0));
  }
  exit(code = 0): void { process.exit(code); }
  relaunch(): void { note('app.relaunch'); }
  setBadgeCount(): boolean { return false; }
  commandLine = { appendSwitch(): void { /* n/a */ }, hasSwitch(): boolean { return false }, getSwitchValue(): string { return ''; } };
}
export const app = new App();

// ── desktop-only surfaces ──────────────────────────────────────────────────────────────────────

export const nativeImage = tolerant('nativeImage', {
  createEmpty: () => tolerant('NativeImage', { isEmpty: () => true, toPNG: () => Buffer.alloc(0), resize() { return this; }, setTemplateImage() { /* n/a */ }, getSize: () => ({ width: 0, height: 0 }) }),
  createFromPath: () => nativeImage.createEmpty(),
  createFromBuffer: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
});

export const session = tolerant('session', {
  defaultSession: tolerant('defaultSession', {
    setPermissionRequestHandler() { /* n/a */ },
    setPermissionCheckHandler() { /* n/a */ },
    setDevicePermissionHandler() { /* n/a */ },
    webRequest: tolerant('webRequest', { onHeadersReceived() { /* n/a */ }, onBeforeRequest() { /* n/a */ } }),
    protocol: tolerant('session.protocol', { handle() { /* n/a */ }, unhandle() { /* n/a */ } }),
    on() { /* n/a */ },
  }),
  fromPartition: () => session.defaultSession,
});

class Nt extends EventEmitter { shouldUseDarkColors = true; themeSource = 'system'; shouldUseHighContrastColors = false; }
export const nativeTheme = new Nt();

export const screen = tolerant('screen', Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getAllDisplays: () => [screen.getPrimaryDisplay()],
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  getDisplayMatching: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
}));

let clip = '';
export const clipboard = tolerant('clipboard', {
  readText: () => clip,
  writeText: (t: string) => { clip = String(t); },
  readImage: () => nativeImage.createEmpty(),
  writeImage() { /* n/a */ },
  readHTML: () => '',
  write(d: { text?: string }) { if (d && typeof d.text === 'string') clip = d.text; },
  availableFormats: () => [],
});

export const shell = tolerant('shell', {
  /* The client opens URLs in ITS browser (RFC §5.4): forward the intent instead of launching a
     browser on a headless host. */
  openExternal: async (url: string) => { broadcast('host:openExternal', [url]); },
  openPath: async () => 'not available on the host',
  showItemInFolder: () => undefined,
  beep: () => undefined,
  trashItem: async (p: string) => { await fs.promises.rm(p, { recursive: true, force: true }); },
});

export const dialog = tolerant('dialog', {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: () => 0,
  showErrorBox: (t: string, c: string) => console.error(`[host] ${t}: ${c}`),
});

export class Menu {
  static buildFromTemplate(items: unknown[]): Menu { const m = new Menu(); m.items = items; return m; }
  static setApplicationMenu(): void { /* no menu bar on a host */ }
  static getApplicationMenu(): Menu | null { return null; }
  items: unknown[] = [];
  popup(): void { /* client-side */ }
  closePopup(): void { /* client-side */ }
  append(i: unknown): void { this.items.push(i); }
  getMenuItemById(): null { return null; }
}
export class MenuItem { constructor(public opts: unknown) { } }

export class Tray extends EventEmitter {
  setToolTip(): void { /* n/a */ } setContextMenu(): void { /* n/a */ } setImage(): void { /* n/a */ }
  setTitle(): void { /* n/a */ } destroy(): void { /* n/a */ } isDestroyed(): boolean { return false; }
  setIgnoreDoubleClickEvents(): void { /* n/a */ } popUpContextMenu(): void { /* n/a */ }
}

export class Notification extends EventEmitter {
  static isSupported(): boolean { return false; }
  constructor(public opts: unknown) { super(); }
  show(): void { /* the client shows notifications (RFC §5.4) */ }
  close(): void { /* n/a */ }
}

export const globalShortcut = tolerant('globalShortcut', {
  register: () => false, unregister: () => undefined, unregisterAll: () => undefined, isRegistered: () => false,
});

let blockerId = 0;
export const powerSaveBlocker = tolerant('powerSaveBlocker', {
  start: () => ++blockerId, stop: () => undefined, isStarted: () => false,
});
export const powerMonitor = tolerant('powerMonitor', Object.assign(new EventEmitter(), {
  getSystemIdleTime: () => 0, getSystemIdleState: () => 'active', isOnBatteryPower: () => false, onBatteryPower: false,
}));

export const protocol = tolerant('protocol', {
  registerSchemesAsPrivileged: () => undefined, handle: () => undefined, unhandle: () => undefined, isProtocolHandled: () => false,
});

export const webUtils = { getPathForFile: () => '' };
export const contextBridge = { exposeInMainWorld: () => undefined };
export const ipcRenderer = inert('ipcRenderer');

export const BrowserWindow = FakeBrowserWindow;
export const WebContentsView = FakeBrowserWindow;

/** The module object `require('electron')` resolves to in host mode. */
export const electronModule = tolerant('electron', {
  app, ipcMain, BrowserWindow, WebContentsView, Menu, MenuItem, Tray, Notification, nativeImage, nativeTheme,
  session, screen, clipboard, shell, dialog, globalShortcut, powerSaveBlocker, powerMonitor, protocol,
  webUtils, contextBridge, ipcRenderer,
  autoUpdater: Object.assign(new EventEmitter(), { setFeedURL() { /* n/a */ }, checkForUpdates() { /* n/a */ }, quitAndInstall() { /* n/a */ } }),
});
