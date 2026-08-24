import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const contract = packageJson.stage5Browser;
if (
  typeof packageJson.version !== 'string' ||
  typeof contract?.workerProtocolVersion !== 'number' ||
  typeof contract?.toolCatalogVersion !== 'number' ||
  typeof contract?.toolCount !== 'number'
) {
  throw new Error('package.json must define the Stage5 Browser runtime contract.');
}
const outputDirectory = path.join(packageRoot, 'dist');
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, 'build-stamp.json'),
  `${JSON.stringify({
    version: packageJson.version,
    buildId: randomUUID(),
    builtAt: new Date().toISOString(),
    workerProtocolVersion: contract.workerProtocolVersion,
    toolCatalogVersion: contract.toolCatalogVersion,
    toolCount: contract.toolCount,
  })}\n`,
  { encoding: 'utf8', mode: 0o644 },
);
