/** Host: one question to one agent (agentChat.ts) — agent lookup, read-only arguments, stream parsing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chatArgs, eventsOf, resolveAgent } from '../host/agentChat';

function framework(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-agent-chat-'));
  fs.mkdirSync(path.join(root, 'agents', 'custom'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents', 'aios', 'finance-legal'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'custom', 'comptable.md'), '# custom');
  fs.writeFileSync(path.join(root, 'agents', 'aios', 'finance-legal', 'accountant.md'), '# bundled');
  fs.writeFileSync(path.join(root, 'agents', 'aios', 'finance-legal', 'comptable.md'), '# bundled twin');
  return root;
}

test('resolveAgent: custom first, then bundled, never a path', () => {
  const root = framework();
  assert.equal(resolveAgent(root, 'comptable'), path.join(root, 'agents', 'custom', 'comptable.md'));
  assert.equal(resolveAgent(root, 'accountant'), path.join(root, 'agents', 'aios', 'finance-legal', 'accountant.md'));
  assert.equal(resolveAgent(root, 'nobody'), null);
  assert.equal(resolveAgent(root, '../custom/comptable'), null);
  assert.equal(resolveAgent(root, 'Comptable'), null);
});

test('chatArgs: read-only tools, nothing else allowed, resume only when given', () => {
  const base = { agentFile: 'a.md', mcpConfig: 'm.json', mcpNames: ['mylittlecrm'], message: 'Bonjour', sessionId: null, model: 'sonnet', effort: 'medium' };
  const args = chatArgs(base);
  const val = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(val('--tools'), 'Read,Grep,Glob');
  assert.equal(val('--allowedTools'), 'Read,Grep,Glob,mcp__mylittlecrm');
  assert.equal(val('--permission-mode'), 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(val('--append-system-prompt-file'), 'a.md');
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('bypassPermissions'));
  const resumed = chatArgs({ ...base, sessionId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' });
  assert.equal(resumed[resumed.indexOf('--resume') + 1], '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
});

test('eventsOf: text deltas, tool starts, the final result', () => {
  assert.deepEqual(eventsOf({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bon' } } }), [{ type: 'text', text: 'Bon' }]);
  assert.deepEqual(eventsOf({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__mylittlecrm__crm_get' } } }), [{ type: 'tool', name: 'mcp__mylittlecrm__crm_get' }]);
  assert.deepEqual(eventsOf({ type: 'result', subtype: 'success', is_error: false, session_id: 'abc' }), [{ type: 'done', sessionId: 'abc' }]);
  assert.equal(eventsOf({ type: 'result', subtype: 'error_max_turns', is_error: true })[0]!.type, 'error');
  assert.deepEqual(eventsOf({ type: 'assistant' }), []);
});
