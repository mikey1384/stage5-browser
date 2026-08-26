import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testTempBase = path.join(
  process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(),
  'stage5-browser-tests.noindex',
);
await mkdir(testTempBase, { recursive: true, mode: 0o700 });
await writeFile(path.join(testTempBase, '.metadata_never_index'), '', {
  flag: 'a',
  mode: 0o600,
});
const testTempRoot = await mkdtemp(path.join(testTempBase, 'run-'));

const vitestEntry = path.resolve('node_modules', 'vitest', 'vitest.mjs');
const forwardedArguments = process.argv.slice(2);
const modeArguments = forwardedArguments.includes('--watch') ? [] : ['run'];
const child = spawn(
  process.execPath,
  [vitestEntry, ...modeArguments, ...forwardedArguments],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: path.resolve('.playwright-browsers'),
      STAGE5_BROWSER_HEADLESS: '1',
      TEMP: testTempRoot,
      TMP: testTempRoot,
      TMPDIR: testTempRoot,
    },
    stdio: 'inherit',
  },
);

const exitCode = await new Promise((resolve) => {
  child.once('error', () => resolve(1));
  child.once('exit', (code, signal) => resolve(signal === null ? (code ?? 1) : 1));
});
await rm(testTempRoot, { recursive: true, force: true }).catch(() => undefined);
process.exitCode = exitCode;
