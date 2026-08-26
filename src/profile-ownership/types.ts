import type { BrowserEngine, BrowserProduct } from '../browser-provider.js';

export type ProfileOwnershipControlMode = 'human_handoff' | 'native_cdp' | 'playwright';
export type ProfileOwnershipPhase =
  | 'close_requested'
  | 'human_input'
  | 'launching'
  | 'owned_active'
  | 'process_exited'
  | 'profile_unlocked';

export interface ProfileOwnershipLease {
  version: 1;
  leaseId: string;
  browser: BrowserProduct;
  engine: BrowserEngine;
  profileFingerprint: string;
  ownerWorkerProcessId: number;
  ownerWorkerStartedAt: string;
  browserProcessId: number | null;
  browserProcessStartedAt: string | null;
  browserExecutableFingerprint: string | null;
  controlMode: ProfileOwnershipControlMode;
  phase: ProfileOwnershipPhase;
  createdAt: string;
  heartbeatAt: string;
}

export interface ProfileOwnershipLeaseInspection {
  state:
    | 'abandoned'
    | 'busy_other_stage5_session'
    | 'current_owner'
    | 'invalid'
    | 'none'
    | 'owned_orphaned';
  lease: ProfileOwnershipLease | null;
  ownershipProven: boolean;
  ownerWorkerRunning: boolean | null;
  heartbeat: 'fresh' | 'stale' | 'unavailable';
  browserProcess: 'matched' | 'mismatched' | 'not_running' | 'unavailable';
}

export interface OwnedProcessObservation {
  processId: number;
  startedAt: string;
  executablePath: string;
}

export interface ProcessTableEntry {
  processId: number;
  parentProcessId: number;
  executablePath: string;
}

export interface ProfileOwnershipDependencies {
  now: () => Date;
  processRunning: (processId: number) => boolean;
  processStartedAt: (processId: number) => Promise<string | null>;
  processExecutable: (processId: number) => Promise<string | null>;
  processTable: () => Promise<ProcessTableEntry[] | null>;
  signalProcess: (processId: number, signal: NodeJS.Signals) => void;
}
