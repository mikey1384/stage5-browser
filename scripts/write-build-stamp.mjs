import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const outputDirectory = path.join(packageRoot, 'dist');
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, 'build-stamp.json'),
  `${JSON.stringify({ version: packageJson.version, buildId: randomUUID(), builtAt: new Date().toISOString() })}\n`,
  { encoding: 'utf8', mode: 0o644 },
);
