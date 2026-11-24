/** aios-brain: the parts that decide who and what gets in. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { pkceOk, redirectAllowed, vaultPath } from '../host/brain';

test('only Claude callbacks and loopback apps may register', () => {
  assert.equal(redirectAllowed('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(redirectAllowed('https://claude.com/api/mcp/auth_callback'), true);
  assert.equal(redirectAllowed('http://localhost:33418/callback'), true);
  assert.equal(redirectAllowed('http://127.0.0.1:5555/cb'), true);
  assert.equal(redirectAllowed('https://evil.example/callback'), false);
  assert.equal(redirectAllowed('https://claude.ai.evil.example/api/mcp/auth_callback'), false);
  assert.equal(redirectAllowed('http://localhost.evil.example/cb'), false);
});

test('PKCE S256 is checked exactly', () => {
  const v = crypto.randomBytes(40).toString('base64url');
  const c = crypto.createHash('sha256').update(v).digest('base64url');
  assert.equal(pkceOk(v, c), true);
  assert.equal(pkceOk(v + 'x', c), false);
  assert.equal(pkceOk('short', crypto.createHash('sha256').update('short').digest('base64url')), false, 'verifier too short');
});

test('vault paths stay in the vault and avoid hidden and secret files', () => {
  const vault = path.resolve('/tmp/vault');
  assert.equal(vaultPath(vault, '00 - notes/projects/a.md'), path.join(vault, '00 - notes', 'projects', 'a.md'));
  assert.equal(vaultPath(vault, '../USER.md'), null);
  assert.equal(vaultPath(vault, '00 - notes/../../x.md'), null);
  assert.equal(vaultPath(vault, '.obsidian/workspace.json'), null);
  assert.equal(vaultPath(vault, 'notes/.env'), null);
  assert.equal(vaultPath(vault, ''), null);
});
