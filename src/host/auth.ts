/* HOST MODE — device pairing (docs/rfcs/cloud-mode.md §7).

   A device pairs by typing a short-lived, single-use code generated ON THE HOST (`aios-host pair`, or
   printed at start while no device is paired). Pairing issues a per-device secret, kept by the
   browser in an HttpOnly cookie; the host stores only its SHA-256. Revoking a device deletes its
   record, and the gateway closes its open connections at once. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A paired device. `role` (RFC §7): a client opens the UI; a node only registers capabilities. Missing = client. */
export interface Device { id: string; name: string; hash: string; createdAt: number; lastSeen: number; role?: 'client' | 'node'; }
interface PairingCode { hash: string; expiresAt: number; }

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I: it is read off one screen and typed on another

function sha256(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

export class DeviceStore {
  private readonly devicesFile: string;
  private readonly codesFile: string;
  /** Failed code attempts, to slow a guesser down (5 wrong codes → 5 minutes locked, jarvis-fr's rule). */
  private failures: number[] = [];
  /** The last list read successfully. A read that fails for another reason than a missing file (Windows:
      the file is being replaced, or held by an antivirus scan) returns it instead of "no device": an empty
      answer made the revoke poll close every page as revoked, and a pairing then rewrote the file with
      only the new device. */
  private lastGood: Device[] = [];

  constructor(home: string) {
    this.devicesFile = path.join(home, 'devices.json');
    this.codesFile = path.join(home, 'pairing-codes.json');
  }

  list(): Device[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.devicesFile, 'utf8').replace(/^﻿/, '')) as unknown;
      if (Array.isArray(v)) this.lastGood = v as Device[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.lastGood = [];
    }
    return this.lastGood.map((d) => ({ ...d }));
  }

  /** A new single-use code, valid ten minutes. Files are shared with the running host, so the CLI and the server agree without IPC. */
  newCode(): string {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const now = Date.now();
    const codes = readJson<PairingCode[]>(this.codesFile, []).filter((c) => c.expiresAt > now);
    codes.push({ hash: sha256(code), expiresAt: now + CODE_TTL_MS });
    writePrivate(this.codesFile, codes);
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  locked(): boolean {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 5 * 60 * 1000);
    return this.failures.length >= 5;
  }

  /** Spend a code: returns the new device's cookie value (`id.secret`), or null. */
  pair(rawCode: string, name: string, role: 'client' | 'node' = 'client'): string | null {
    if (this.locked()) return null;
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const now = Date.now();
    const codes = readJson<PairingCode[]>(this.codesFile, []).filter((c) => c.expiresAt > now);
    const h = sha256(code);
    const hit = codes.findIndex((c) => safeEqualHex(c.hash, h));
    if (hit < 0) { this.failures.push(now); return null; }
    codes.splice(hit, 1);
    writePrivate(this.codesFile, codes);
    const id = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const devices = this.list();
    devices.push({ id, name: String(name || 'browser').slice(0, 120), hash: sha256(secret), createdAt: now, lastSeen: now, role });
    writePrivate(this.devicesFile, devices);
    return `${id}.${secret}`;
  }

  /** The device a cookie value belongs to, or null. Reads the file each time so a revoke from the CLI takes effect at once. */
  verify(cookie: string | undefined): Device | null {
    if (!cookie) return null;
    const [id, secret] = cookie.split('.');
    if (!id || !secret) return null;
    const d = this.list().find((x) => x.id === id);
    return d && safeEqualHex(d.hash, sha256(secret)) ? d : null;
  }

  touch(id: string): void {
    const devices = this.list();
    const d = devices.find((x) => x.id === id);
    if (!d) return;
    d.lastSeen = Date.now();
    writePrivate(this.devicesFile, devices);
  }

  revoke(id: string): boolean {
    const devices = this.list();
    const next = devices.filter((d) => d.id !== id);
    if (next.length === devices.length) return false;
    writePrivate(this.devicesFile, next);
    return true;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
