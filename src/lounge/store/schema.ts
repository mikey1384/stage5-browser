import { STORE_INITIALIZATION_RETRY_MS, STORE_INITIALIZATION_TIMEOUT_MS, STORE_INITIALIZATION_WAIT, retryableSqliteContention } from './model.js';
import type { LoungeStoreContext } from './runtime.js';

export const schemaOperations = {
  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  },

  initialize(): void {
    const deadline = Date.now() + STORE_INITIALIZATION_TIMEOUT_MS;
    while (true) {
      try {
        this.database.exec('PRAGMA busy_timeout = 5000');
        this.database.exec('PRAGMA foreign_keys = ON');
        this.database.exec('PRAGMA journal_mode = WAL');
        this.database.exec('PRAGMA synchronous = NORMAL');
        this.migrate();
        return;
      } catch (error) {
        if (!retryableSqliteContention(error) || Date.now() >= deadline) throw error;
        Atomics.wait(
          STORE_INITIALIZATION_WAIT,
          0,
          0,
          Math.min(STORE_INITIALIZATION_RETRY_MS, Math.max(1, deadline - Date.now())),
        );
      }
    }
  },

  migrate(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS lounges (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          provider TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memberships (
          lounge_id TEXT NOT NULL REFERENCES lounges(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          joined_at_ms INTEGER NOT NULL,
          left_at_ms INTEGER,
          PRIMARY KEY (lounge_id, agent_id)
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          lounge_id TEXT NOT NULL REFERENCES lounges(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          client_instance_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('connected_non_wakeable', 'listening', 'processing', 'offline')
          ),
          started_at_ms INTEGER NOT NULL,
          heartbeat_at_ms INTEGER NOT NULL,
          lease_until_ms INTEGER NOT NULL,
          closed_at_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS lounge_sessions_by_agent
          ON sessions (lounge_id, agent_id, started_at_ms DESC);

        CREATE TABLE IF NOT EXISTS messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          lounge_id TEXT NOT NULL REFERENCES lounges(id),
          sender_agent_id TEXT NOT NULL REFERENCES agents(id),
          kind TEXT NOT NULL CHECK (kind IN (
            'message',
            'task',
            'blocker',
            'completion',
            'finding',
            'dependency_resolved',
            'question',
            'answer',
            'handoff'
          )),
          body TEXT NOT NULL,
          reply_to_message_id TEXT REFERENCES messages(id),
          task_key TEXT,
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          UNIQUE (lounge_id, sender_agent_id, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS lounge_messages_by_room
          ON messages (lounge_id, sequence);

        CREATE TABLE IF NOT EXISTS deliveries (
          message_id TEXT NOT NULL REFERENCES messages(id),
          recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
          state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'seen', 'acted')),
          delivery_attempts INTEGER NOT NULL,
          delivered_at_ms INTEGER,
          seen_at_ms INTEGER,
          acted_at_ms INTEGER,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (message_id, recipient_agent_id)
        );

        CREATE INDEX IF NOT EXISTS lounge_deliveries_by_recipient
          ON deliveries (recipient_agent_id, state, updated_at_ms);

        CREATE TABLE IF NOT EXISTS lounge_notices (
          lounge_id TEXT PRIMARY KEY REFERENCES lounges(id),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          body TEXT,
          pinned_by_agent_id TEXT REFERENCES agents(id),
          pinned_at_ms INTEGER,
          CHECK (
            (body IS NULL AND pinned_by_agent_id IS NULL AND pinned_at_ms IS NULL) OR
            (body IS NOT NULL AND pinned_by_agent_id IS NOT NULL AND pinned_at_ms IS NOT NULL)
          )
        );

        CREATE TABLE IF NOT EXISTS lounge_notice_mutations (
          lounge_id TEXT NOT NULL REFERENCES lounges(id),
          actor_agent_id TEXT NOT NULL REFERENCES agents(id),
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          body TEXT,
          created_at_ms INTEGER NOT NULL,
          PRIMARY KEY (lounge_id, actor_agent_id, idempotency_key),
          UNIQUE (lounge_id, revision)
        );

        CREATE TABLE IF NOT EXISTS lounge_history_audits (
          id TEXT PRIMARY KEY,
          lounge_id TEXT NOT NULL REFERENCES lounges(id),
          manager_agent_id TEXT NOT NULL REFERENCES agents(id),
          session_id TEXT NOT NULL REFERENCES sessions(id),
          before_sequence INTEGER,
          after_sequence INTEGER,
          requested_limit INTEGER NOT NULL,
          result_count INTEGER NOT NULL,
          oldest_sequence INTEGER,
          newest_sequence INTEGER,
          created_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS lounge_history_audits_by_room
          ON lounge_history_audits (lounge_id, created_at_ms DESC);

        PRAGMA user_version = 2;
      `);
    });
  },
} satisfies Record<string, unknown> & ThisType<LoungeStoreContext>;

export type SchemaOperations = typeof schemaOperations;
