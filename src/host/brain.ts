/* aios-brain — the vault as a remote MCP connector for any Claude conversation (claude.ai web, mobile,
   desktop, Claude Code), plan phase 3.

   It is the ONLY part of the host exposed to the internet, so it lives on its own loopback port (4801),
   published alone with Tailscale Funnel on 443 (claude.ai accepts no other port); the AIOS UI moves to :8443 and stays
   tailnet-only. Every MCP request needs an OAuth 2.1 access token (MCP authorization spec):
     /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server, /register (dynamic
     client registration, Claude's callbacks and loopback only), /authorize (PKCE S256 required) →
     GitHub login → /github/callback (ONLY the configured GitHub account) → /token (code, refresh).
   GitHub credentials come from a GitHub App the host creates with GitHub's manifest flow
   (setup page on the tailnet UI: /brain/setup), stored in ~/.aios/host/brain.json.

   Tools: vault_search, vault_read (inside the vault, secrets and .obsidian refused), vault_note (APPEND
   only, to a .md in the vault, one git commit "brain: …"), agents_status, agent_spawn (spawn inbox). */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { activity, INBOX } from './scheduler';

export interface BrainConfig {
  githubClientId?: string; githubClientSecret?: string; githubAppSlug?: string;
  allowedGithubLogin?: string; publicBaseUrl?: string; port?: number;
}
interface Client { id: string; name: string; redirectUris: string[]; createdAt: number; }
interface Pending { clientId: string; redirectUri: string; challenge: string; state: string; resource?: string; at: number; nonce?: string; consented?: boolean; }
interface Grant { clientId: string; redirectUri: string; challenge: string; login: string; at: number; }
interface Token { hash: string; kind: 'access' | 'refresh'; clientId: string; login: string; exp: number; }

const ACCESS_TTL = 3600_000;
const REFRESH_TTL = 30 * 24 * 3600_000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');

/** Redirect URIs a client may register: Claude's OAuth callbacks, or a loopback app (RFC 8252). */
export function redirectAllowed(u: string): boolean {
  if (u === 'https://claude.ai/api/mcp/auth_callback' || u === 'https://claude.com/api/mcp/auth_callback') return true;
  try { const x = new URL(u); return x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1'); } catch { return false; }
}

export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return crypto.createHash('sha256').update(verifier).digest('base64url') === challenge;
}

/** A vault-relative path, resolved and confined; null for anything outside, hidden, or secret. */
export function vaultPath(vault: string, rel: string): string | null {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((s) => s === '..' || s.startsWith('.'))) return null;
  const p = path.resolve(vault, clean);
  if (p !== vault && !p.startsWith(vault + path.sep)) return null;
  if (/(^|[\\/])(\.env|credentials|.*\.key|.*\.pem)$/i.test(p)) return null;
  return p;
}

export class Brain {
  private cfg: BrainConfig = {};
  private readonly cfgFile: string;
  private readonly stateFile: string;
  private clients: Client[] = [];
  private tokens: Token[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly grants = new Map<string, Grant>();
  private readonly setupStates = new Set<string>();
  private readonly vault: string;
  private fails: number[] = [];

  constructor(private readonly hostHome: string, private readonly framework: string, private readonly liveSessions: () => string[]) {
    this.cfgFile = path.join(hostHome, 'brain.json');
    this.stateFile = path.join(hostHome, 'brain-state.json');
    this.vault = path.join(framework, 'vault');
    this.load();
  }

  private load(): void {
    try { this.cfg = JSON.parse(fs.readFileSync(this.cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch { this.cfg = {}; }
    try { const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); this.clients = s.clients || []; this.tokens = s.tokens || []; } catch { /* fresh */ }
  }
  private saveCfg(): void { fs.writeFileSync(this.cfgFile, JSON.stringify(this.cfg, null, 2), { mode: 0o600 }); }
  private saveState(): void {
    const now = Date.now();
    this.tokens = this.tokens.filter((t) => t.exp > now);
    fs.writeFileSync(this.stateFile, JSON.stringify({ clients: this.clients, tokens: this.tokens }, null, 1), { mode: 0o600 });
  }

  get configured(): boolean { return !!(this.cfg.githubClientId && this.cfg.githubClientSecret && this.cfg.publicBaseUrl); }
  get publicUrl(): string { return String(this.cfg.publicBaseUrl || '').replace(/\/$/, ''); }
  get connectorUrl(): string { return `${this.publicUrl}/mcp`; }

  // ── setup (served on the tailnet UI by the gateway, behind device pairing) ───────────────────

  /** The public base URL from Tailscale, saved once. */
  async ensurePublicBase(): Promise<string> {
    if (this.cfg.publicBaseUrl) return this.cfg.publicBaseUrl;
    const dns = await new Promise<string>((resolve) => {
      const exe = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
      execFile(exe, ['status', '--json'], { windowsHide: true }, (e, out) => {
        try { resolve(String(JSON.parse(out).Self.DNSName || '').replace(/\.$/, '')); } catch { resolve(''); }
      });
    });
    /* Port 443: claude.ai refuses a connector URL with any other port. */
    if (dns) { this.cfg.publicBaseUrl = `https://${dns}`; this.saveCfg(); }
    return this.cfg.publicBaseUrl || '';
  }

  funnel(): Promise<{ ok: boolean; out: string }> {
    return new Promise((resolve) => {
      const exe = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
      execFile(exe, ['funnel', '--bg', '--https=443', `http://127.0.0.1:${this.cfg.port || 4801}`], { windowsHide: true, timeout: 20_000 }, (e, out, err) => {
        const text = `${out}${err}`.trim();
        resolve({ ok: !e && !/not enabled|error/i.test(text), out: text });
      });
    });
  }

  funnelStatus(): Promise<string> {
    return new Promise((resolve) => {
      const exe = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
      execFile(exe, ['funnel', 'status'], { windowsHide: true, timeout: 10_000 }, (_e, out, err) => resolve(`${out}${err}`));
    });
  }

  /** The GitHub App manifest (GitHub's manifest flow creates the app and hands back its credentials). */
  manifest(tailnetBase: string): { state: string; manifest: string } {
    const state = rand(16);
    this.setupStates.add(state);
    const m = {
      name: `aios-brain-${crypto.randomBytes(3).toString('hex')}`,
      url: this.publicUrl,
      description: 'Accès OAuth à mon vault AIOS pour Claude (connecteur aios-brain)',
      redirect_url: `${tailnetBase}/brain/setup/done`,
      callback_urls: [`${this.publicUrl}/github/callback`],
      public: false,
      default_permissions: {},
      request_oauth_on_install: false,
      setup_on_update: false,
    };
    return { state, manifest: JSON.stringify(m) };
  }

  /** GitHub redirected back with a one-time code: turn it into the app's client id and secret. */
  async setupDone(code: string, state: string): Promise<string> {
    if (!this.setupStates.delete(state)) throw new Error('état de configuration inconnu ou expiré');
    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'aios-host' } });
    const j = await res.json() as Record<string, any>;
    if (!res.ok || !j.client_id || !j.client_secret) throw new Error(`GitHub a refusé la conversion (${res.status})`);
    this.cfg.githubClientId = j.client_id;
    this.cfg.githubClientSecret = j.client_secret;
    this.cfg.githubAppSlug = j.slug;
    if (!this.cfg.allowedGithubLogin && j.owner?.login) this.cfg.allowedGithubLogin = j.owner.login;
    this.saveCfg();
    activity(this.hostHome, 'brain', `GitHub App « ${j.slug} » créée pour aios-brain (compte autorisé : ${this.cfg.allowedGithubLogin})`);
    return String(this.cfg.allowedGithubLogin || '');
  }

  // ── the public server ──────────────────────────────────────────────────────────────────────

  start(): void {
    const port = this.cfg.port || 4801;
    http.createServer((req, res) => { void this.handle(req, res).catch((e) => { console.error('[brain]', e); if (!res.headersSent) { res.writeHead(500); res.end(); } }); })
      .listen(port, '127.0.0.1', () => console.log(`[brain] listening on 127.0.0.1:${port} (public: ${this.publicUrl || 'not set up'})`));
  }

  private json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }

  private async body(req: http.IncomingMessage): Promise<string> {
    let b = '';
    for await (const c of req) { b += c; if (b.length > 256 * 1024) throw new Error('body too large'); }
    return b;
  }

  private throttled(): boolean {
    const now = Date.now();
    this.fails = this.fails.filter((t) => now - t < 10 * 60_000);
    return this.fails.length > 30;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://brain');
    const base = this.publicUrl;
    /* One line per request (method, path, status, client) to diagnose a connector that will not connect.
       Never the query string or headers: they carry codes and tokens. */
    const t0 = Date.now();
    res.on('finish', () => console.log(`[brain] ${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - t0} ms, ${String(req.headers['user-agent'] || '?').slice(0, 40)})`));
    if (!this.configured && url.pathname !== '/') { this.json(res, 503, { error: 'aios-brain is not set up yet' }); return; }
    switch (url.pathname) {
      case '/': res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('aios-brain'); return;
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        this.json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] }); return;
      case '/.well-known/oauth-authorization-server':
        this.json(res, 200, {
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['vault'],
        }); return;
      case '/register': return this.register(req, res);
      case '/authorize': return this.authorize(url, res);
      case '/authorize/consent': return this.consent(req, res);
      case '/github/callback': return this.githubCallback(url, res, req);
      case '/token': return this.token(req, res);
      case '/mcp': return this.mcp(req, res);
      default: res.writeHead(404); res.end();
    }
  }

  private async register(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let m: any;
    try { m = JSON.parse(await this.body(req)); } catch { this.json(res, 400, { error: 'invalid_client_metadata' }); return; }
    const uris: string[] = Array.isArray(m.redirect_uris) ? m.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every(redirectAllowed)) { this.json(res, 400, { error: 'invalid_redirect_uri', error_description: 'only Claude callbacks or loopback redirects' }); return; }
    if (this.clients.length > 50) this.clients = this.clients.slice(-40);
    const c: Client = { id: `c_${rand(18)}`, name: String(m.client_name || 'client').slice(0, 80), redirectUris: uris, createdAt: Date.now() };
    this.clients.push(c);
    this.saveState();
    this.json(res, 201, { client_id: c.id, client_name: c.name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  }

  private authorize(url: URL, res: http.ServerResponse): void {
    const q = url.searchParams;
    const client = this.clients.find((c) => c.id === q.get('client_id'));
    const redirectUri = String(q.get('redirect_uri') || '');
    if (!client || !client.redirectUris.includes(redirectUri)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('client ou redirect_uri inconnu'); return; }
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      const r = new URL(redirectUri); r.searchParams.set('error', 'invalid_request'); r.searchParams.set('error_description', 'PKCE S256 required');
      if (q.get('state')) r.searchParams.set('state', String(q.get('state')));
      res.writeHead(302, { Location: r.toString() }); res.end(); return;
    }
    /* CONSENT, bound to THIS browser (MCP spec, proxies with a static upstream client). Without it, anyone
       could register a client, start a flow, and send the operator the link: GitHub, already authorized,
       redirects silently and the code lands in the attacker's flow. The flow cookie (SameSite=Lax) ties
       the consent POST and the GitHub callback to the browser that saw this page. */
    const rid = rand(16), nonce = rand(24);
    this.pending.set(rid, { clientId: client.id, redirectUri, challenge: String(q.get('code_challenge')), state: String(q.get('state') || ''), resource: q.get('resource') || undefined, at: Date.now(), nonce, consented: false });
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    let dest = redirectUri;
    try { dest = new URL(redirectUri).host; } catch { /* keep */ }
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>aios-brain — autoriser ?</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}.w{background:#fff4e5;border-radius:8px;padding:.8rem 1rem}button{padding:.6rem 1.2rem;border-radius:8px;border:0;font-size:1rem;margin-right:.5rem;cursor:pointer}.ok{background:#2f81f7;color:#fff}.no{background:#eee}</style></head><body>
<h1>Autoriser l'accès à ton vault ?</h1>
<p>L'application <b>${esc(client.name)}</b> (retour vers <b>${esc(dest)}</b>, enregistrée le ${esc(new Date(client.createdAt).toLocaleString('fr-FR'))}) demande à lire ton vault, y ajouter des notes et lancer des agents AIOS.</p>
<p class="w">Si tu n'as pas toi-même cliqué « Connecter » dans Claude à l'instant, <b>refuse</b> : quelqu'un essaie de se brancher sur ton vault.</p>
<form method="post" action="/authorize/consent"><input type="hidden" name="rid" value="${esc(rid)}">
<button class="ok" name="decision" value="allow">Autoriser</button><button class="no" name="decision" value="deny">Refuser</button></form></body></html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Set-Cookie': `aios_brain_flow=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    });
    res.end(html);
  }

  private flowCookie(req: http.IncomingMessage): string {
    const m = /(?:^|;\s*)aios_brain_flow=([^;]+)/.exec(String(req.headers.cookie || ''));
    return m ? m[1] : '';
  }

  private async consent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const f = new URLSearchParams(await this.body(req));
    const rid = String(f.get('rid') || '');
    const p = this.pending.get(rid);
    const site = String(req.headers['sec-fetch-site'] || '');
    let originOk = site === 'same-origin';
    try { originOk = originOk || new URL(String(req.headers.origin)).origin === new URL(this.publicUrl).origin; } catch { /* no origin */ }
    const cookie = this.flowCookie(req);
    if (!p || !originOk || !cookie || !p.nonce || cookie.length !== p.nonce.length || !crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(p.nonce))) {
      this.fails.push(Date.now());
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Demande expirée ou venue d’un autre site : recommence depuis Claude.'); return;
    }
    if (f.get('decision') !== 'allow') {
      this.pending.delete(rid);
      activity(this.hostHome, 'brain', `connexion aios-brain refusée par l'opérateur (client ${p.clientId.slice(0, 8)})`);
      const r = new URL(p.redirectUri); r.searchParams.set('error', 'access_denied'); if (p.state) r.searchParams.set('state', p.state);
      res.writeHead(302, { Location: r.toString() }); res.end(); return;
    }
    p.consented = true;
    const gh = new URL('https://github.com/login/oauth/authorize');
    gh.searchParams.set('client_id', String(this.cfg.githubClientId));
    gh.searchParams.set('redirect_uri', `${this.publicUrl}/github/callback`);
    gh.searchParams.set('state', rid);
    gh.searchParams.set('allow_signup', 'false');
    res.writeHead(302, { Location: gh.toString(), 'Cache-Control': 'no-store' }); res.end();
  }

  private async githubCallback(url: URL, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const rid = String(url.searchParams.get('state') || '');
    const p = this.pending.get(rid);
    this.pending.delete(rid);
    const deny = (why: string) => { this.fails.push(Date.now()); res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`Accès refusé : ${why}`); };
    if (!p || Date.now() - p.at > 10 * 60_000) return deny('demande expirée, recommence depuis Claude');
    /* Only the browser that consented may finish the flow. */
    const cookie = this.flowCookie(req);
    if (!p.consented || !p.nonce || cookie.length !== p.nonce.length || !crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(p.nonce))) return deny('consentement absent ou donné dans un autre navigateur');
    if (this.throttled()) return deny('trop de tentatives');
    const tok = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'aios-host' },
      body: JSON.stringify({ client_id: this.cfg.githubClientId, client_secret: this.cfg.githubClientSecret, code: url.searchParams.get('code'), redirect_uri: `${this.publicUrl}/github/callback` }),
    }).then((r) => r.json() as Promise<Record<string, any>>).catch(() => ({} as Record<string, any>));
    if (!tok.access_token) return deny('GitHub n’a pas confirmé la connexion');
    const user = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'aios-host', Accept: 'application/vnd.github+json' } })
      .then((r) => r.json() as Promise<Record<string, any>>).catch(() => ({} as Record<string, any>));
    const login = String(user.login || '');
    if (!login || login.toLowerCase() !== String(this.cfg.allowedGithubLogin || '').toLowerCase()) {
      activity(this.hostHome, 'brain', `connexion aios-brain refusée pour le compte GitHub « ${login || '?'} »`);
      return deny(`le compte GitHub « ${login} » n’est pas autorisé`);
    }
    const code = rand(24);
    this.grants.set(sha(code), { clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, login, at: Date.now() });
    const r = new URL(p.redirectUri);
    r.searchParams.set('code', code);
    if (p.state) r.searchParams.set('state', p.state);
    res.writeHead(302, { Location: r.toString(), 'Cache-Control': 'no-store' }); res.end();
  }

  private issue(clientId: string, login: string): Record<string, unknown> {
    const access = rand(32), refresh = rand(32), now = Date.now();
    this.tokens.push({ hash: sha(access), kind: 'access', clientId, login, exp: now + ACCESS_TTL });
    this.tokens.push({ hash: sha(refresh), kind: 'refresh', clientId, login, exp: now + REFRESH_TTL });
    this.saveState();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'vault' };
  }

  private async token(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const raw = await this.body(req);
    const f = (req.headers['content-type'] || '').includes('json') ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v)])) : new URLSearchParams(raw);
    const bad = (error: string) => { this.fails.push(Date.now()); this.json(res, 400, { error }); };
    if (this.throttled()) return bad('slow_down');
    if (f.get('grant_type') === 'authorization_code') {
      const g = this.grants.get(sha(String(f.get('code') || '')));
      this.grants.delete(sha(String(f.get('code') || '')));
      if (!g || Date.now() - g.at > 5 * 60_000 || g.clientId !== f.get('client_id') || g.redirectUri !== f.get('redirect_uri')) return bad('invalid_grant');
      if (!pkceOk(String(f.get('code_verifier') || ''), g.challenge)) return bad('invalid_grant');
      this.json(res, 200, this.issue(g.clientId, g.login));
      activity(this.hostHome, 'brain', `aios-brain connecté (client ${g.clientId.slice(0, 8)}, ${g.login})`);
      return;
    }
    if (f.get('grant_type') === 'refresh_token') {
      const h = sha(String(f.get('refresh_token') || ''));
      const t = this.tokens.find((x) => x.hash === h && x.kind === 'refresh' && x.exp > Date.now());
      if (!t || t.clientId !== f.get('client_id')) return bad('invalid_grant');
      this.tokens = this.tokens.filter((x) => x !== t);                       // rotation: a refresh token works once
      this.json(res, 200, this.issue(t.clientId, t.login));
      return;
    }
    bad('unsupported_grant_type');
  }

  private bearer(req: http.IncomingMessage): Token | null {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const h = sha(m[1]);
    return this.tokens.find((t) => t.hash === h && t.kind === 'access' && t.exp > Date.now()) || null;
  }

  // ── MCP (streamable HTTP, JSON responses) ─────────────────────────────────────────────────

  private async mcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const who = this.bearer(req);
    if (!who) {
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${this.publicUrl}/.well-known/oauth-protected-resource"`, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    let msg: any;
    try { msg = JSON.parse(await this.body(req)); } catch { this.json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    const batch = Array.isArray(msg) ? msg : [msg];
    const out = [];
    for (const m of batch) { const r = await this.rpc(m); if (r) out.push(r); }
    if (!out.length) { res.writeHead(202); res.end(); return; }
    this.json(res, 200, Array.isArray(msg) ? out : out[0]);
  }

  private async rpc(m: any): Promise<unknown> {
    if (!m || m.id === undefined || m.id === null) return null;   // notifications
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aios-brain', version: '1.0.0' }, instructions: 'Le vault Obsidian AIOS de l’opérateur : contexte (00 - notes/context), projets (00 - notes/projects), journal (01 - calendar). Cherche avant de lire.' });
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: TOOLS });
    if (m.method === 'tools/call') {
      try { return ok({ content: [{ type: 'text', text: await this.tool(String(m.params?.name), m.params?.arguments || {}) }] }); }
      catch (e) { return ok({ content: [{ type: 'text', text: String((e as Error).message || e) }], isError: true }); }
    }
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
  }

  private mdFiles(dir = this.vault, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this.mdFiles(p, out); else if (e.name.endsWith('.md')) out.push(p);
      if (out.length > 20_000) break;
    }
    return out;
  }

  private async tool(name: string, a: Record<string, any>): Promise<string> {
    const rel = (p: string) => path.relative(this.vault, p).replace(/\\/g, '/');
    switch (name) {
      case 'vault_search': {
        const q = String(a.query || '').trim().toLowerCase();
        if (q.length < 2) throw new Error('query too short');
        const terms = q.split(/\s+/).slice(0, 6);
        const hits: Array<{ path: string; score: number; lines: string[] }> = [];
        for (const f of this.mdFiles()) {
          let text = '';
          try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
          const low = text.toLowerCase(), name = rel(f).toLowerCase();
          const score = terms.reduce((s, t) => s + (name.includes(t) ? 5 : 0) + Math.min(low.split(t).length - 1, 10), 0);
          if (!score || !terms.every((t) => low.includes(t) || name.includes(t))) continue;
          const lines = text.split('\n').filter((l) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 3).map((l) => l.trim().slice(0, 200));
          hits.push({ path: rel(f), score, lines });
        }
        hits.sort((x, y) => y.score - x.score);
        const n = Math.min(Number(a.limit) || 10, 25);
        return hits.length ? hits.slice(0, n).map((h) => `${h.path}\n  ${h.lines.join('\n  ')}`).join('\n') : 'Aucun résultat.';
      }
      case 'vault_read': {
        const p = vaultPath(this.vault, a.path);
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('chemin introuvable ou refusé (relatif au vault, ex. "00 - notes/projects/infra-aios.md")');
        const t = fs.readFileSync(p, 'utf8');
        return t.length > 60_000 ? t.slice(0, 60_000) + '\n… (tronqué)' : t;
      }
      case 'vault_note': {
        const target = vaultPath(this.vault, a.path || '00 - notes/inbox-claude.md');
        const text = String(a.text || '').trim();
        if (!target || !target.endsWith('.md')) throw new Error('note refusée : un .md dans le vault');
        if (!text || text.length > 20_000) throw new Error('texte vide ou trop long');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const stamp = new Date().toLocaleString('fr-FR');
        fs.appendFileSync(target, `${fs.existsSync(target) ? '\n' : ''}- ${stamp} — ${text.replace(/\n/g, '\n  ')} _(via aios-brain)_\n`);
        await new Promise<void>((resolve) => {
          const r = path.relative(this.framework, target);
          const git = (args: string[], cb: () => void) => execFile('git', ['-c', 'user.name=AIOS brain', '-c', 'user.email=brain@aios.local', '-C', this.framework, ...args], { windowsHide: true }, () => cb());
          git(['add', '--', r], () => git(['commit', '-q', '-m', `brain: note in ${rel(target)}`, '--', r], resolve));
        });
        activity(this.hostHome, 'brain', `note ajoutée via aios-brain : ${rel(target)}`);
        return `Ajouté à ${rel(target)}.`;
      }
      case 'agents_status': {
        const live = this.liveSessions();
        return live.length ? `Sessions vivantes sur l'hôte : ${live.join(', ')}` : 'Aucune session vivante sur l’hôte.';
      }
      case 'agent_spawn': {
        const nm = String(a.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        const task = String(a.task || '').trim();
        if (!nm || !task) throw new Error('name et task requis');
        fs.mkdirSync(INBOX, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
        const tmp = path.join(INBOX, `.${stamp}-${nm}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify({ name: nm, task: `${task}\n\n(Demandé depuis une conversation Claude via aios-brain.)`, effort: 'high' }, null, 2));
        fs.renameSync(tmp, path.join(INBOX, `${stamp}-${nm}.json`));
        activity(this.hostHome, 'brain', `agent « ${nm} » lancé via aios-brain`);
        return `Session « ${nm} » demandée à l'hôte ; elle apparaît dans l'AIOS.`;
      }
      default: throw new Error(`outil inconnu ${name}`);
    }
  }
}

const TOOLS = [
  { name: 'vault_search', description: "Cherche dans le vault Obsidian AIOS de l'opérateur (noms et contenu des notes .md). Renvoie les chemins et les lignes qui correspondent.", inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25 } }, required: ['query'] } },
  { name: 'vault_read', description: 'Lit une note du vault par son chemin relatif (ex. "00 - notes/projects/infra-aios.md").', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'vault_note', description: 'AJOUTE (jamais ne remplace) un texte daté à une note .md du vault (par défaut "00 - notes/inbox-claude.md"), avec un commit git. Pour noter une décision, une idée, un fait.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
  { name: 'agents_status', description: "Liste les sessions d'agents AIOS vivantes sur l'hôte.", inputSchema: { type: 'object', properties: {} } },
  { name: 'agent_spawn', description: "Lance une session d'agent AIOS sur l'hôte (nom court + consigne complète). Elle travaille seule et apparaît dans l'AIOS.", inputSchema: { type: 'object', properties: { name: { type: 'string' }, task: { type: 'string' } }, required: ['name', 'task'] } },
];

export const BRAIN_HOME = path.join(os.homedir(), '.aios', 'host');
