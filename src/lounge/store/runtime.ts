import { DatabaseSync, chmodSync, mkdirSync, path } from './dependencies.js';
import { assertIdentifier } from './model.js';
import { sessionsOperations, type SessionsOperations } from './sessions.js';
import { messagesOperations, type MessagesOperations } from './messages.js';
import { statusOperations, type StatusOperations } from './status.js';
import { noticesOperations, type NoticesOperations } from './notices.js';
import { historyOperations, type HistoryOperations } from './history.js';
import { workNoteOperations, type WorkNoteOperations } from './work-notes.js';
import { authorizationOperations, type AuthorizationOperations } from './authorization.js';
import { schemaOperations, type SchemaOperations } from './schema.js';
export interface LoungeStoreContext extends
  SessionsOperations,
  MessagesOperations,
  StatusOperations,
  NoticesOperations,
  HistoryOperations,
  WorkNoteOperations,
  AuthorizationOperations,
  SchemaOperations {
  database: DatabaseSync;
  managerAgentIds: ReadonlySet<string>;
}

export interface LoungeStoreDatabase extends
  SessionsOperations,
  MessagesOperations,
  StatusOperations,
  NoticesOperations,
  HistoryOperations,
  WorkNoteOperations,
  AuthorizationOperations,
  SchemaOperations {}

export class LoungeStoreDatabase {
  private readonly database: DatabaseSync;
  private readonly managerAgentIds: ReadonlySet<string>;

  constructor(readonly databasePath: string, managerAgentIds: string[] = []) {
    const uniqueManagerAgentIds = [...new Set(managerAgentIds)];
    for (const agentId of uniqueManagerAgentIds) {
      assertIdentifier(agentId, 'manager agentId');
    }
    this.managerAgentIds = new Set(uniqueManagerAgentIds);
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath, {
      open: true,
      readOnly: false,
      allowExtension: false,
      timeout: 1_000,
    });
    try {
      this.initialize();
    } catch (error) {
      this.database.close();
      throw error;
    }
    chmodSync(databasePath, 0o600);
  }

  close(): void {
    this.database.close();
  }
}

function installOperations(prototype: object, operations: Readonly<Record<string, unknown>>): void {
  for (const [name, implementation] of Object.entries(operations)) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      enumerable: false,
      value: implementation,
      writable: true,
    });
  }
}

for (const operations of [
  sessionsOperations,
  messagesOperations,
  statusOperations,
  noticesOperations,
  historyOperations,
  workNoteOperations,
  authorizationOperations,
  schemaOperations,
]) {
  installOperations(LoungeStoreDatabase.prototype, operations);
}
