import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const HARD_LIMIT = 1_000;
const SOURCE_ROOTS = ['src', 'tests'];
const TYPESCRIPT_EXTENSION = /\.(?:cts|mts|tsx?|d\.ts)$/u;

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await typescriptFiles(candidate));
    } else if (entry.isFile() && TYPESCRIPT_EXTENSION.test(entry.name)) {
      files.push(candidate);
    }
  }
  return files;
}

const files = (await Promise.all(SOURCE_ROOTS.map(typescriptFiles))).flat();
const oversized = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const lines = source.length === 0
    ? 0
    : source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  if (lines > HARD_LIMIT) oversized.push({ file, lines });
}

if (oversized.length > 0) {
  for (const { file, lines } of oversized.sort((left, right) => right.lines - left.lines)) {
    process.stderr.write(`${file}: ${lines} lines (hard limit ${HARD_LIMIT})\n`);
  }
  process.exitCode = 1;
}
