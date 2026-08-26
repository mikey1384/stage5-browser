import {
  type Download,
  type DownloadListOutput,
  type DownloadObservation,
  mkdir,
  path,
  randomUUID,
  stat,
  type WaitForDownloadOutput,
} from '../dependencies.js';
import { DurableJsonFile } from '../persistence/durable-json.js';

const MANIFEST_VERSION = 1;
const MAX_RETAINED_RECORDS = 200;

interface DownloadManifest {
  version: typeof MANIFEST_VERSION;
  sequence: number;
  downloads: DownloadObservation[];
}

function isManifest(value: unknown): value is DownloadManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DownloadManifest>;
  return candidate.version === MANIFEST_VERSION
    && Number.isSafeInteger(candidate.sequence)
    && Array.isArray(candidate.downloads)
    && candidate.downloads.every(isObservation);
}

function safeExtension(suggestedFilename: string): string | null {
  const extension = path.extname(suggestedFilename).slice(1).toLocaleLowerCase();
  return /^[a-z0-9]{1,10}$/u.test(extension) ? extension : null;
}

function copyObservation(observation: DownloadObservation): DownloadObservation {
  return {
    ...observation,
    artifact: { ...observation.artifact },
  };
}

function isObservation(value: unknown): value is DownloadObservation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DownloadObservation>;
  return typeof candidate.downloadId === 'string'
    && Number.isSafeInteger(candidate.sequence)
    && typeof candidate.state === 'string'
    && typeof candidate.capturedAt === 'string'
    && typeof candidate.artifact === 'object'
    && candidate.artifact !== null;
}

export class BrowserDownloadManager {
  private sequence = 0;
  private readonly records = new Map<string, DownloadObservation>();
  private readonly manifest: DurableJsonFile<DownloadManifest>;
  private readonly ready: Promise<void>;
  private persistTail: Promise<void> = Promise.resolve();

  constructor(private readonly downloadsDir: string) {
    this.manifest = new DurableJsonFile(path.join(downloadsDir, 'manifest.json'), isManifest);
    this.ready = this.restore();
  }

  capture(download: Download): void {
    void this.captureDownload(download).catch(() => undefined);
  }

  async list(limit = 100): Promise<DownloadListOutput> {
    await this.ready;
    const downloads = [...this.records.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-Math.max(1, Math.min(MAX_RETAINED_RECORDS, limit)))
      .map(copyObservation);
    return {
      cursor: this.sequence,
      downloads,
      persistence: 'durable_sanitized_manifest',
    };
  }

  async cursor(): Promise<number> {
    await this.ready;
    return this.sequence;
  }

  async after(sequence: number): Promise<DownloadObservation[]> {
    const result = await this.list(MAX_RETAINED_RECORDS);
    return result.downloads.filter((download) => download.sequence > sequence);
  }

  async waitAfter(afterSequence: number, timeoutMs: number): Promise<WaitForDownloadOutput> {
    await this.ready;
    const startedAt = Date.now();
    while (this.sequence <= afterSequence && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, timeoutMs - (Date.now() - startedAt))));
    }
    const result = await this.list();
    return {
      ...result,
      observed: result.downloads.some((download) => download.sequence > afterSequence),
    };
  }

  private async captureDownload(download: Download): Promise<void> {
    await this.ready;
    const extension = safeExtension(download.suggestedFilename());
    const downloadId = `download-${randomUUID()}`;
    const artifactPath = path.join(this.downloadsDir, `${downloadId}${extension === null ? '' : `.${extension}`}`);
    const observation: DownloadObservation = {
      downloadId,
      sequence: ++this.sequence,
      state: 'in_progress',
      capturedAt: new Date().toISOString(),
      completedAt: null,
      artifact: { path: null, extension, sizeBytes: null },
      failure: null,
    };
    this.records.set(downloadId, observation);
    this.trimRecords();
    await this.persist();

    try {
      await download.saveAs(artifactPath);
      const browserFailure = await download.failure();
      if (browserFailure !== null) {
        observation.state = 'failed';
        observation.failure = 'browser_reported_failure';
      } else {
        const artifact = await stat(artifactPath);
        observation.state = 'completed';
        observation.artifact = {
          path: artifactPath,
          extension,
          sizeBytes: artifact.isFile() ? artifact.size : null,
        };
      }
    } catch {
      observation.state = 'failed';
      observation.failure = 'artifact_write_failed';
    }
    observation.completedAt = new Date().toISOString();
    await this.persist();
  }

  private async restore(): Promise<void> {
    await mkdir(this.downloadsDir, { recursive: true, mode: 0o700 });
    const manifest = await this.manifest.read();
    if (manifest === null) return;
    let interrupted = false;
    for (const value of manifest.downloads) {
      if (!isObservation(value)) continue;
      const observation = copyObservation(value);
      if (observation.state === 'in_progress') {
        observation.state = 'interrupted';
        observation.failure = 'capture_interrupted';
        observation.completedAt = new Date().toISOString();
        interrupted = true;
      }
      this.records.set(observation.downloadId, observation);
      this.sequence = Math.max(this.sequence, observation.sequence);
    }
    this.sequence = Math.max(this.sequence, manifest.sequence);
    this.trimRecords();
    if (interrupted) await this.writeManifest();
  }

  private trimRecords(): void {
    const ordered = [...this.records.values()].sort((left, right) => left.sequence - right.sequence);
    for (const observation of ordered.slice(0, Math.max(0, ordered.length - MAX_RETAINED_RECORDS))) {
      this.records.delete(observation.downloadId);
    }
  }

  private persist(): Promise<void> {
    this.persistTail = this.persistTail.then(() => this.writeManifest());
    return this.persistTail;
  }

  private async writeManifest(): Promise<void> {
    const manifest: DownloadManifest = {
      version: MANIFEST_VERSION,
      sequence: this.sequence,
      downloads: [...this.records.values()].sort((left, right) => left.sequence - right.sequence),
    };
    await this.manifest.write(manifest);
  }
}
