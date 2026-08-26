export const DOWNLOAD_STATES = ['in_progress', 'completed', 'failed', 'interrupted'] as const;
export type DownloadState = (typeof DOWNLOAD_STATES)[number];

export interface DownloadObservation {
  downloadId: string;
  sequence: number;
  state: DownloadState;
  capturedAt: string;
  completedAt: string | null;
  artifact: {
    path: string | null;
    extension: string | null;
    sizeBytes: number | null;
  };
  failure: 'browser_reported_failure' | 'capture_interrupted' | 'artifact_write_failed' | null;
}

export interface DownloadListOutput {
  cursor: number;
  downloads: DownloadObservation[];
  persistence: 'durable_sanitized_manifest';
}

export interface WaitForDownloadInput {
  afterSequence: number;
  timeoutMs: number;
}

export interface WaitForDownloadOutput extends DownloadListOutput {
  observed: boolean;
}
