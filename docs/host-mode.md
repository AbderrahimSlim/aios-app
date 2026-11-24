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
Only a pty's owner may write to, resize, kill or query it. When a pty is taken back, the renderer's
opening command (`pty:run`) is swallowed: it is never typed into the live session.

## Sessions outlive the host

Ptys live in a separate **session supervisor** (`src/host/supervisor.ts`), started detached by the host
and reached over a local socket (a named pipe on Windows) that requires the token in
`~/.aios/host/supervisor.token`. The host sees a `node-pty` stand-in (`src/host/ptyBridge.ts`), so
main.ts is unchanged. When the host restarts, the supervisor hands the new host every live pty with
what it printed meanwhile; a client takes one back by name. The supervisor exits after ten minutes
with no pty and no host. `AIOS_HOST_NO_SUPERVISOR=1` keeps ptys in the host process.

A pty taken back after a host restart is a plain terminal to the host: the chat view and the Running
card do not see it until it is reopened.

## Not yet (next steps of phase 1)

- A machine reboot ends every pty; named Claude sessions come back with `--resume`.
- Several viewers on one session, and an explicit "take control".
- File uploads for drag-and-drop (the browser never learns a dropped file's path).
- Desktop-only surfaces are inert in host mode: tray, global quick bar, keep-awake, auto-update,
  `<webview>` browser panes, native menus.

## Jarvis (plan phase 2)

A voice conductor runs inside the host (`src/jarvis/`); the page gets an orb at the bottom left
(`Alt+J`). It is one persistent Claude Code session (`claude -p` over stream-json; latest Sonnet,
effort high, `bypassPermissions`) in its own workspace `~/.aios/host/jarvis/`, which holds its persona
(`CLAUDE.md`, editable, kept on update) and the only settings it loads (`--setting-sources project`,
`--strict-mcp-config`): global hooks and MCP servers are never loaded, nothing global is written. It
answers briefly and launches AIOS agents through the spawn inbox for longer work.

Firewall that still applies in bypass mode: deny rules plus the `guard` hook (`src/jarvis/guard.ts`):
writes only inside the framework, the inbox and the workspace; shell commands parsed (recursive deletes
outside those roots, force-push, disk/registry tools, download-into-interpreter, secrets are refused);
for 5 minutes after reading outside content (web, mail/chat MCP), shell and PC-node actions are refused.
It fails closed. About 120 ms per tool call on Windows (Node start-up).

Voice engines (`~/.aios/host/jarvis.json`, all optional):

```json
{ "apiKey": "<Gradium key>", "voiceId": "F7Iib4MAyHIRed0x", "language": "fr", "endOfTurn": 0.8 }
```

With a key (or `GRADIUM_API_KEY`), Gradium does speech-to-text and text-to-speech on the host; without
one, the browser's own Web Speech API does both. The device that spoke last gets the audio; every
device sees the transcript. Anti-echo (default on) mutes the mic while Jarvis speaks; with a headset,
untick it to interrupt Jarvis by speaking. "Stop", "tais-toi", "annule" only interrupt.

Agent launches from Jarvis go through the spawn inbox, which the host fulfils by opening a pane in a
connected page: with no page open, the request waits (headless fulfilment is plan phase 3).

## Autonomy (plan phase 3)

- **Bus requests go to one place.** "Open / send to / close a session" go to the client that acted last,
  or are fulfilled by the host itself when no page is open (the session runs detached and is taken back
  by name later). A session started in an untrusted folder stops on Claude Code's trust question, which
  the host never answers: trust the AIOS folder once by opening `claude` there.
- **Routines** are vault notes in `00 - notes/routines/` (cron `schedule`, `via: agent|jarvis`); see the
  `_index.md` there. Health rows in `~/.aios/health/routine-<name>.json`.
- **Governor** (`~/.aios/host/governor.json`: `maxFiveHourPct` 70, `maxConcurrent` 2): background work waits
  while the 5-hour usage (Claude Code's status-line cache) is over the threshold.
- **Memory distiller** (`~/.aios/host/memory.json`: `enabled`, `idleMinutes` 15, `maxPerHour` 6): a session
  idle for 15 minutes is distilled by a one-shot Claude with no tools and no saved session; facts go to
  `vault/00 - notes/context/observed/*.md`, one `memory:` commit per session (revert to forget).
  Existing transcripts are never distilled retroactively.
- **"While you were away"**: the Jarvis panel lists what routines, memory and the bus did since the device
  last looked (`~/.aios/host/activity.jsonl`).
- **`jarvis-mobile`** (opt-in, `"mobileSession": true` in `jarvis.json`): a session kept alive for the
  Claude app's Remote Control.

## Nodes: Jarvis's hands on a PC (plan phase 4)

A PC running [jarvis-node](../../jarvis-node) (separate repository, CC BY-NC) pairs with the role
`node` (`POST /pair` with `role=node` and no `Origin`), connects outbound to `/node` with its bearer
credential, and declares typed capabilities. The broker (`src/host/nodes.ts`, RFC §5.5) validates
arguments against each capability's schema, routes the call (the machine the speaking device runs on, set
in the Jarvis panel; else the only node online; else it asks), and records queued → leased → done / failed /
cancelled / unknown, with deadlines; a node dropping mid-call re-queues repeatable capabilities only.
Jarvis reaches it through the `aios-nodes` MCP server (`src/jarvis/nodesMcp.ts`) over the loopback-only,
token-guarded `/internal/nodes`. Screen captures land in `vault/02 - assets/generated/screens/`.

## aios-brain: the vault as a remote MCP connector

`src/host/brain.ts` serves MCP over HTTP on its own loopback port (4801), published ALONE with Tailscale
Funnel on 8443 (the AIOS UI stays tailnet-only). OAuth 2.1 (dynamic client registration limited to
Claude's callbacks and loopback apps, PKCE S256, rotating refresh tokens) delegates the login to GitHub
and admits one GitHub account only. The GitHub App is created by GitHub's manifest flow from
`/brain/setup` on the tailnet UI (three clicks: allow Funnel, create the app, add the connector URL in
claude.ai). Tools: vault_search, vault_read, vault_note (append-only, one `brain:` commit), agents_status,
agent_spawn.
