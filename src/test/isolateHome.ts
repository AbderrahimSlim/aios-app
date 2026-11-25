/* Loaded by `npm test` through `--import`, in the runner and in every test file's process, before any test code.
   It points the home directory at a throwaway folder, so no test can read or write the operator's own files.

   Why it exists: the App stores the operator's framework path in `~/.aios/app.json`, and that setting outranks
   GLASS_FRAMEWORK_PATH by design (setting → env → default). On a machine where the App has been used, every
   test that sets GLASS_FRAMEWORK_PATH to a fixture silently ran against the operator's real vault instead,
   failed, and rewrote its `.glass/state.json` and `.glass/shell.json` with test values. A clean CI runner has
   no such file, so CI never saw it.

   The folder lives under `out/`, never under the system temp folder: some tests assert that the temp folder is
   refused as a workspace, and a home inside it would make them disagree with themselves. Both HOME and
   USERPROFILE are set because os.homedir() reads USERPROFILE on Windows and HOME elsewhere. */
import * as fs from 'fs';
import * as path from 'path';

const home = fs.mkdtempSync(path.join(__dirname, '..', '.test-home-'));
/* Kept for the one caller that needs it: Electron on Windows will not start with a foreign profile
   (boardIsolation.e2e.test.ts). Never use it to read the operator's files. */
if (process.env.USERPROFILE && !process.env.AIOS_REAL_USERPROFILE) process.env.AIOS_REAL_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AIOS_TEST_HOME = home;
process.on('exit', () => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort; out/ is disposable */ }
});
