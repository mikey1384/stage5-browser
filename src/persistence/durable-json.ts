import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class DurableJsonFile<Value> {
  constructor(
    private readonly filePath: string,
    private readonly validate: (value: unknown) => value is Value,
  ) {}

  async read(): Promise<Value | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return null;
    }
    return this.validate(parsed) ? parsed : null;
  }

  async write(value: Value): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
