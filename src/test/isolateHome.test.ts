/* The test suite must never touch the operator's home: see isolateHome.ts for the incident. This file fails when
   `npm test` stops loading the isolation, which would otherwise be silent on every machine without an App
   setting, CI included. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('npm test loads the home isolation before any test runs', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.test, /--import \.\/out\/test\/isolateHome\.js/, 'the test script loads isolateHome');
});

test('os.homedir() is a throwaway folder under out/, not the operator home and not the temp folder', () => {
  const home = process.env.AIOS_TEST_HOME;
  if (!home) return; // run outside `npm test` (a single file by hand): nothing to check here
  assert.equal(os.homedir(), home);
  assert.match(path.basename(home), /^\.test-home-/);
  assert.ok(!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep), 'home must not sit inside the temp folder');
  assert.ok(!fs.existsSync(path.join(home, '.aios', 'app.json')), 'no stored App setting can reach the tests');
});
