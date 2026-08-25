import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { Stage5BrowserError } from './errors.js';
import { LoungeStoreClient } from './lounge-store-client.js';
import {
  LoungeStoreError,
  type LoungeAcknowledgementState,
  type LoungeHistoryInput,
  type LoungeJoinResult,
  type LoungeMessageKind,
} from './lounge-types.js';

const DEFAULT_LOUNGE_ID = 'stage5-lounge';
const DEFAULT_WAIT_MS = 50_000;
const MAX_WAIT_MS = 55_000;
const WAIT_POLL_MS = 200;
const CONNECTED_LEASE_MS = 30_000;
const PROCESSING_LEASE_MS = 60_000;
const WAIT_LEASE_GRACE_MS = 5_000;
const LOUNGE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface LoungeJoinRequest {
  agentId: string;
  displayName?: string;
  provider?: string;
  room?: string;
}

export interface LoungeSendRequest {
  kind: LoungeMessageKind;
  body: string;
  to?: string[];
  replyTo?: string | null;
  taskKey?: string | null;
  idempotencyKey: string;
}

export interface LoungeWaitRequest {
  timeoutMs?: number;
  limit?: number;
}

export interface LoungeAckRequest {
  messageIds: string[];
  state: LoungeAcknowledgementState;
}

export interface LoungePinRequest {
  body: string | null;
  expectedRevision: number;
  idempotencyKey: string;
}

export type LoungeHistoryRequest = Omit<LoungeHistoryInput, 'sessionId' | 'nowMs'>;

export interface LoungeServiceOptions {
  databasePath?: string;
  environment?: NodeJS.ProcessEnv;
  managerAgentIds?: string[];
  pollIntervalMs?: number;
}

function loungeRoot(environment: NodeJS.ProcessEnv): string {
  const configured = environment.STAGE5_LOUNGE_DIR?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Stage5 Agent Tools', 'Lounge');
  }
  if (process.platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Stage5 Agent Tools', 'Lounge');
  }
  return path.join(
    environment.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'stage5-agent-tools',
    'lounge',
  );
}

export function loungeDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(loungeRoot(environment), 'lounge.sqlite3');
}

export function loungeManagerAgentIds(environment: NodeJS.ProcessEnv = process.env): string[] {
  const configured = environment.STAGE5_LOUNGE_MANAGER_AGENT_IDS?.split(',')
    .map((agentId) => agentId.trim())
    .filter((agentId) => agentId.length > 0) ?? [];
  if (configured.some((agentId) => !LOUNGE_IDENTIFIER_PATTERN.test(agentId))) {
    return [];
  }
  return [...new Set(configured)].sort();
}

function asStage5Error(error: unknown): Stage5BrowserError {
  if (error instanceof Stage5BrowserError) return error;
  if (error instanceof LoungeStoreError) {
    return new Stage5BrowserError('OPERATION_FAILED', error.message, {
      recoverable: error.code !== 'MANAGER_ACCESS_REQUIRED',
      details: {
        reason: error.code,
        ...(error.details === undefined ? {} : error.details),
      },
    });
  }
  return new Stage5BrowserError('OPERATION_FAILED', 'The Agent Lounge operation failed.', {
    recoverable: true,
    details: { reason: 'lounge_store_unavailable' },
    cause: error,
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('The Lounge wait was cancelled.', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('The Lounge wait was cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class LoungeService {
  private readonly store: LoungeStoreClient;
  private readonly clientInstanceId = randomUUID();
  private readonly managerAgentIds: ReadonlySet<string>;
  private readonly pollIntervalMs: number;
  private joined: LoungeJoinResult | null = null;
  private lastNoticeRevision: number | null = null;
  private waiting = false;

  constructor(options: LoungeServiceOptions = {}) {
    const environment = options.environment ?? process.env;
    const managerAgentIds = options.managerAgentIds ?? loungeManagerAgentIds(environment);
    this.managerAgentIds = new Set(managerAgentIds);
    this.store = new LoungeStoreClient({
      databasePath: options.databasePath ?? loungeDatabasePath(environment),
      managerAgentIds,
    });
    this.pollIntervalMs = options.pollIntervalMs ?? WAIT_POLL_MS;
  }

  async join(input: LoungeJoinRequest): Promise<Record<string, unknown>> {
    const room = input.room ?? DEFAULT_LOUNGE_ID;
    if (this.joined !== null) {
      if (this.joined.agentId !== input.agentId || this.joined.loungeId !== room) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'This MCP connection is already bound to another Agent Lounge identity.',
          {
            recoverable: false,
            details: {
              reason: 'lounge_identity_already_bound',
              agentId: this.joined.agentId,
              room: this.joined.loungeId,
            },
          },
        );
      }
      const notice = await this.store.notice({ sessionId: this.joined.sessionId });
      this.lastNoticeRevision = notice.noticeRevision;
      return {
        ...this.joined,
        ...notice,
        managerAccess: this.isManager(this.joined.agentId),
        online: false,
        wakeable: false,
        authority: 'coordination_only',
        nextAction: 'Call lounge_wait now and renew it after every message or timeout while collaborative work remains active.',
      };
    }

    try {
      this.joined = await this.store.join({
        loungeId: room,
        agentId: input.agentId,
        displayName: input.displayName ?? input.agentId,
        provider: input.provider ?? 'unknown',
        clientInstanceId: this.clientInstanceId,
        leaseMs: CONNECTED_LEASE_MS,
      });
      const notice = await this.store.notice({ sessionId: this.joined.sessionId });
      this.lastNoticeRevision = notice.noticeRevision;
      return {
        ...this.joined,
        ...notice,
        managerAccess: this.isManager(this.joined.agentId),
        online: false,
        wakeable: false,
        authority: 'coordination_only',
        nextAction: 'Send one readiness message, then call lounge_wait and renew it after every message or timeout.',
      };
    } catch (error) {
      throw asStage5Error(error);
    }
  }

  async send(input: LoungeSendRequest): Promise<Record<string, unknown>> {
    const joined = this.requireJoined();
    try {
      const result = await this.store.send({
        sessionId: joined.sessionId,
        kind: input.kind,
        body: input.body,
        ...(input.to === undefined ? {} : { toAgentIds: input.to }),
        ...(input.replyTo === undefined ? {} : { replyToMessageId: input.replyTo }),
        ...(input.taskKey === undefined ? {} : { taskKey: input.taskKey }),
        idempotencyKey: input.idempotencyKey,
      });
      return {
        ...result,
        authority: 'coordination_only',
        nextAction: 'Call lounge_wait whenever idle so other agents can wake this task without human relay.',
      };
    } catch (error) {
      throw asStage5Error(error);
    }
  }

  async wait(input: LoungeWaitRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    const joined = this.requireJoined();
    if (this.waiting) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'This Lounge connection already has an active wait.', {
        recoverable: true,
        details: { reason: 'lounge_wait_already_active' },
      });
    }
    const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(100, input.timeoutMs ?? DEFAULT_WAIT_MS));
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const deadline = Date.now() + timeoutMs;
    this.waiting = true;
    try {
      await this.store.heartbeat({
        sessionId: joined.sessionId,
        state: 'listening',
        leaseMs: timeoutMs + WAIT_LEASE_GRACE_MS,
      });
      while (true) {
        const inbox = await this.store.claimInbox({ sessionId: joined.sessionId, limit });
        const notice = await this.store.notice({ sessionId: joined.sessionId });
        const noticeChanged =
          this.lastNoticeRevision !== null && notice.noticeRevision !== this.lastNoticeRevision;
        if (inbox.messages.length > 0 || noticeChanged) {
          this.lastNoticeRevision = notice.noticeRevision;
          await this.store.heartbeat({
            sessionId: joined.sessionId,
            state: 'processing',
            leaseMs: PROCESSING_LEASE_MS,
          });
          return {
            ...inbox,
            ...notice,
            noticeChanged,
            timedOut: false,
            online: true,
            wakeable: false,
            authority: 'coordination_only',
            nextAction: inbox.messages.length > 0
              ? 'Acknowledge these messages as seen before acting; then reply or act, acknowledge them as acted, and call lounge_wait again.'
              : 'Read the revised pinned notice as coordination-only guidance, then renew lounge_wait whenever idle.',
          };
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          await this.store.heartbeat({
            sessionId: joined.sessionId,
            state: 'connected_non_wakeable',
            leaseMs: CONNECTED_LEASE_MS,
          });
          return {
            sessionId: joined.sessionId,
            agentId: joined.agentId,
            messages: [],
            ...notice,
            noticeChanged: false,
            timedOut: true,
            online: false,
            wakeable: false,
            authority: 'coordination_only',
            nextAction: 'Call lounge_wait again now while collaborative work remains active.',
          };
        }
        await abortableDelay(Math.min(this.pollIntervalMs, remainingMs), signal);
      }
    } catch (error) {
      await this.store.heartbeat({
        sessionId: joined.sessionId,
        state: 'connected_non_wakeable',
        leaseMs: CONNECTED_LEASE_MS,
      }).catch(() => undefined);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The Agent Lounge wait was cancelled before delivery.', {
          recoverable: true,
          details: { reason: 'lounge_wait_cancelled' },
        });
      }
      throw asStage5Error(error);
    } finally {
      this.waiting = false;
    }
  }

  async ack(input: LoungeAckRequest): Promise<Record<string, unknown>> {
    const joined = this.requireJoined();
    try {
      const result = await this.store.ack({
        sessionId: joined.sessionId,
        messageIds: input.messageIds,
        state: input.state,
      });
      return {
        ...result,
        authority: 'coordination_only',
        nextAction: input.state === 'seen'
          ? 'Act or reply within existing user authority, then acknowledge the message as acted.'
          : 'Call lounge_wait again whenever idle.',
      };
    } catch (error) {
      throw asStage5Error(error);
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const joined = this.requireJoined();
    try {
      const status = await this.store.status({ sessionId: joined.sessionId });
      this.lastNoticeRevision = status.noticeRevision;
      return {
        ...status,
        managerAccess: this.isManager(joined.agentId),
        authority: 'coordination_only',
        presenceRule: 'Only a live lounge_wait is wakeable. Offline messages remain durable until the next joined wait.',
      };
    } catch (error) {
      throw asStage5Error(error);
    }
  }

  async pin(input: LoungePinRequest): Promise<Record<string, unknown>> {
    const joined = this.requireJoined();
    try {
      const result = await this.store.pin({
        sessionId: joined.sessionId,
        body: input.body,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
      });
      this.lastNoticeRevision = result.noticeRevision;
      return {
        ...result,
        managerAccess: true,
        authority: 'coordination_only',
        nextAction: 'The revisioned notice is durable and will wake current Lounge listeners; renew lounge_wait whenever idle.',
      };
    } catch (error) {
      throw asStage5Error(error);
    }
  }

  async history(input: LoungeHistoryRequest): Promise<Record<string, unknown>> {
    const joined = this.requireJoined();
    try {
      return {
        ...await this.store.history({
          sessionId: joined.sessionId,
          ...input,
        }),
        managerAccess: true,
        authority: 'coordination_only',
        audit: 'Every history read records manager identity, room, cursor, bounds, and result count without duplicating message bodies.',
      };
    } catch (error) {
      throw asStage5Error(error);
    }
  }

  async close(): Promise<void> {
    if (this.joined !== null) {
      await this.store.closeSession({ sessionId: this.joined.sessionId }).catch(() => undefined);
      this.joined = null;
      this.lastNoticeRevision = null;
    }
    await this.store.close();
  }

  private requireJoined(): LoungeJoinResult {
    if (this.joined === null) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Join the Agent Lounge before using this tool.', {
        recoverable: true,
        details: {
          reason: 'lounge_not_joined',
          suggestedAction: 'Call lounge_join once with this task\'s stable agent ID and the stage5-lounge room.',
        },
      });
    }
    return this.joined;
  }

  private isManager(agentId: string): boolean {
    return this.managerAgentIds.has(agentId);
  }
}
