# Host mode: the AIOS App in a browser, served by an always-on machine

Status: phase 1, step 1 of [`rfcs/cloud-mode.md`](rfcs/cloud-mode.md). The desktop app is unchanged.

## What it is

`aios-host` runs the App's **unmodified main process** under plain Node (an `electron` stand-in,
`src/host/electronShim.ts`) and serves `renderer/` to any browser. In the page, the compiled desktop
preload runs unchanged against a WebSocket-backed `ipcRenderer` (`renderer/web/web-shell.js`), so
`window.glassShell` has the same methods, channels and argument shapes as on the desktop.

Sessions, the spawn inbox, the vault and git all live on the host. A browser is a view.

## Run it

```bash
npm run host                      # compile, then start on 127.0.0.1:4800
node out/host/main.js pair        # one-time pairing code (10 min) for a new device
node out/host/main.js devices     # paired devices
node out/host/main.js revoke <id> # revoke one; its open connections close within seconds
```

Open `http://127.0.0.1:4800/` on the host, or reach it from other devices through your tailnet:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4800
# → https://<machine>.<tailnet>.ts.net/
```

TLS is required for voice: browsers only grant the microphone on https or localhost.

Windows, start at logon and restart on failure: `scripts/host-windows.ps1 install | status | uninstall`.

Do not run the desktop App and the host on the same machine at the same time: both fulfil
`~/.aios/spawn-inbox/`.

## Security (RFC §7)

- Loopback bind by default (`AIOS_HOST_BIND` to change it; a warning is printed beyond loopback).
- Pairing: single-use host-generated codes; per-device secrets stored as SHA-256 only; HttpOnly,
  SameSite=Strict cookie (Secure when not on localhost); five wrong codes lock pairing for five minutes.
- WebSocket: paired cookie **and** an `Origin` equal to the page's host; messages shape-checked,
  16 MB frames, bounded requests in flight.
- Static files: `renderer/`, an allowlist of `node_modules` packages and the compiled preload only.
- `/hostfile` (viewers): inside the explorer's roots only, symlinks resolved; HTML/SVG are served with
  `Content-Security-Policy: sandbox` so a vault page cannot reach `glassShell`.

## Sessions outlive their client

Every pty is spawned with a host-side router as its sender. When the owning browser goes, the pty keeps
running **detached** and its output is buffered (256 KB). A client opening a terminal under the same
name, which the renderer's restore and resume paths do, gets the live pty back with what it missed.
Only a pty's owner may write to, resize, kill or query it.

## Not yet (next steps of phase 1)

- A separate session-supervisor process, so a **host** restart keeps ptys alive (today a host restart
  ends them; named Claude sessions come back with `--resume`).
- Several viewers on one session, and an explicit "take control".
- File uploads for drag-and-drop (the browser never learns a dropped file's path).
- Desktop-only surfaces are inert in host mode: tray, global quick bar, keep-awake, auto-update,
  `<webview>` browser panes, native menus.
