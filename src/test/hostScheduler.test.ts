/** Host phase 3: cron, routine notes, and the distiller's parsing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatches, nextRun, parseCron } from '../host/cron';
import { parseRoutine } from '../host/scheduler';
import { exchanges, parseFacts } from '../host/distiller';

test('cron: fields, lists, ranges, steps, both day fields', () => {
  const c = parseCron('0 8 * * 1-5');
  assert.equal(cronMatches(c, new Date(2026, 10, 24, 8, 0)), true);    // a Tuesday
  assert.equal(cronMatches(c, new Date(2026, 10, 29, 8, 0)), false);   // a Sunday
  assert.equal(cronMatches(parseCron('*/15 * * * *'), new Date(2026, 0, 1, 3, 45)), true);
  assert.equal(cronMatches(parseCron('0 0 1 * 0'), new Date(2026, 10, 29, 0, 0)), true, 'dom OR dow when both are set');
  assert.equal(cronMatches(parseCron('30 7 * * 7'), new Date(2026, 10, 29, 7, 30)), true, '7 is Sunday');
  assert.deepEqual(nextRun(c, new Date(2026, 10, 28, 12, 0)), new Date(2026, 10, 30, 8, 0));
  assert.throws(() => parseCron('61 * * * *'));
  assert.throws(() => parseCron('* * *'));
});

test('routine notes: frontmatter, defaults, errors', () => {
  const r = parseRoutine('/v/Briefing Matin.md', '---\nschedule: "0 8 * * 1-5"\nvia: jarvis\n---\nFais-moi le point du jour.\n');
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.slug, 'briefing-matin');
  assert.equal(r.via, 'jarvis');
  assert.equal(r.enabled, true);
  const off = parseRoutine('/v/x.md', '---\nschedule: 0 9 * * *\nenabled: false # pas encore\nagent: accountant\n---\nTVA');
  assert.ok(!('error' in off) && off.enabled === false && off.agent === 'accountant' && off.via === 'agent');
  assert.ok('error' in parseRoutine('/v/y.md', '---\nschedule: tous les jours\n---\nx'));
  assert.ok('error' in parseRoutine('/v/z.md', 'pas de frontmatter'));
});

test('distiller: only the conversation text, and a strict answer format', () => {
  const lines = [
    { type: 'user', message: { content: 'Je préfère les réponses courtes.' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Noté.' }, { type: 'tool_use', name: 'Read' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'secret file body' }] } },
    { type: 'user', isSidechain: true, message: { content: 'sub-agent chatter' } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const t = exchanges(lines);
  assert.match(t, /OPÉRATEUR : Je préfère/);
  assert.match(t, /CLAUDE : Noté\./);
  assert.doesNotMatch(t, /secret file body|sub-agent/);
  assert.deepEqual(parseFacts('Voici : {"facts":[{"file":"preferences","text":"Préfère des réponses courtes et directes."},{"file":"bogus","text":"Travaille sur un AIOS web hébergé."}]}'),
    [{ file: 'preferences', text: 'Préfère des réponses courtes et directes.' }, { file: 'session-insights', text: 'Travaille sur un AIOS web hébergé.' }]);
  assert.deepEqual(parseFacts('rien'), []);
  assert.deepEqual(parseFacts('{"facts":[{"file":"preferences","text":"court"}]}'), [], 'too short to be a fact');
});
