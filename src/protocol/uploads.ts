import type { FrameSummary, PageSummary } from './browser-state.js';
import type { FileProcessingExpectation, FileSelectionWarning } from './controls.js';
import type { BrowserDialogActionResult, BrowserDialogExpectation } from './dialogs.js';

export interface SetInputFilesInput {
  snapshotId: string;
  ref: string;
  paths: string[];
  frameId: string | null;
  completion: FileProcessingExpectation | null;
  observationMs: number;
  previewDepth: number;
  timeoutMs: number;
  dialogResponse?: BrowserDialogExpectation | null;
}

export interface SetInputFilesOutput {
  page: PageSummary;
  frame: FrameSummary;
  selection: {
    dispatched: true;
    confirmedByInput: true;
    fileCount: number;
    totalBytes: number;
    files: Array<{ name: string; sizeBytes: number }>;
  };
  attachmentPreview: {
    observation: 'bounded_semantic_preview';
    available: boolean;
    depth: number;
    snapshotId: string | null;
    snapshot: string | null;
  };
  processing: {
    state: 'completion_observed' | 'error_observed' | 'in_progress' | 'unverified';
    evidence:
      | 'expected_completion_visible'
      | 'expected_error_visible'
      | 'network_error_observed'
      | 'progress_active'
      | 'progress_complete'
      | 'progress_disappeared'
      | 'none';
    progress: {
      observed: boolean;
      activeAtReturn: boolean;
      completionValueObserved: boolean;
      disappearedAfterObservation: boolean;
      maxPercentObserved: number | null;
    };
    pageActivity: {
      attribution: 'temporal_only';
      observationMs: number;
      successfulResponses: number;
      redirects: number;
      httpErrors: number;
      failedRequests: number;
    };
  };
  warnings: FileSelectionWarning[];
  dialog?: BrowserDialogActionResult;
}
