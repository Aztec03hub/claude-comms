// seedData.ts — programmatic test-data seeding for E2E scenarios.
//
// Writes the on-disk artifacts the daemon expects to rehydrate at startup:
//   - {dataDir}/registry.db          (sqlite, schema_version=3)
//   - {dataDir}/conversations/<name>/meta.json
//   - {dataDir}/logs/<name>.jsonl    (broker.replay_jsonl_logs reads these)
//
// Schema and file layout verified against:
//   - src/claude_comms/registry_store.py (_SCHEMA_DDL)
//   - src/claude_comms/conversation.py   (ConversationMeta + meta_path)
//   - src/claude_comms/broker.py         (replay_jsonl_logs: log_dir/*.jsonl)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface SeedParticipant {
  key: string;            // 8 hex chars
  name: string;
  type: 'human' | 'claude';
}

export interface SeedChannel {
  name: string;
  topic?: string;
  created_by: string;     // participant name
  visibility?: 'public' | 'private';
  mode?: 'open' | 'invite';
  members?: string[];     // participant keys to add to conversation_members
  archived?: boolean;
}

export interface SeedRole {
  conversation: string;
  participantKey: string;
  role: 'owner' | 'admin' | 'member';
}

export interface SeedMessage {
  conv: string;
  sender: SeedParticipant | { key: '00000000'; name: 'system'; type: 'system' };
  body: string;
  reply_to?: string | null;
  thread_root?: string | null;
  messageType?: 'chat' | 'system';
  ts?: string;  // ISO 8601; auto-assigned if omitted
}

export interface SeedSpec {
  participants: SeedParticipant[];
  channels: SeedChannel[];
  roles: SeedRole[];
  messages: SeedMessage[];
}

const SCHEMA_VERSION = 3;

// SCHEMA mirrored 1:1 from src/claude_comms/registry_store.py:51-103.
// Kept literal so a future schema bump fails LOUDLY at the test level, not
// silently with mismatched columns the daemon will reject.
const _SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS participants (
    key                         TEXT PRIMARY KEY,
    name                        TEXT NOT NULL,
    type                        TEXT NOT NULL CHECK (type IN ('claude','human')),
    created_at                  TEXT NOT NULL,
    last_seen                   TEXT NOT NULL,
    profile_status_emoji        TEXT NULL,
    profile_status_text         TEXT NULL,
    profile_status_expires_at   TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_participants_name_lower ON participants (LOWER(name));

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation     TEXT NOT NULL,
    participant_key  TEXT NOT NULL,
    joined_at        TEXT NOT NULL,
    PRIMARY KEY (conversation, participant_key),
    FOREIGN KEY (participant_key) REFERENCES participants(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS read_cursors (
    participant_key  TEXT NOT NULL,
    conversation     TEXT NOT NULL,
    last_read_ts     TEXT NOT NULL,
    PRIMARY KEY (participant_key, conversation),
    FOREIGN KEY (participant_key) REFERENCES participants(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS thread_read_cursors (
    participant_key  TEXT NOT NULL,
    conversation     TEXT NOT NULL,
    root_id          TEXT NOT NULL,
    last_read_ts     TEXT NOT NULL,
    PRIMARY KEY (participant_key, conversation, root_id),
    FOREIGN KEY (participant_key) REFERENCES participants(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_roles (
    conversation     TEXT NOT NULL,
    participant_key  TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    granted_at       TEXT NOT NULL,
    PRIMARY KEY (conversation, participant_key),
    FOREIGN KEY (participant_key) REFERENCES participants(key) ON DELETE CASCADE
);
`;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build a deterministic timestamp series so seeded messages have a stable
 * chronological order across test runs.
 * Snapshots can mask timestamp display text but the ORDER of messages must
 * be reproducible for screenshot stability.
 */
function makeMessageTimestamps(count: number, anchor: Date = new Date('2026-05-20T12:00:00Z')): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(anchor.getTime() + i * 30_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }
  return out;
}

/**
 * Write the registry.db sqlite file at {dataDir}/registry.db with seeded
 * participants, conversation_members, and conversation_roles.
 *
 * IMPORTANT: the registry_store's 1->2 migration backfills creator-owner roles
 * by scanning meta.json files. We seed roles explicitly anyway so the test does
 * not depend on the migration running (it skips when schema_version is already
 * at the latest, and we set it to the latest below).
 */
function writeRegistryDb(dbPath: string, spec: SeedSpec): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(_SCHEMA_DDL);

  // Mark schema as already migrated so the daemon does not attempt the
  // 1->2 or 2->3 backfills against our seed data.
  const schemaInsert = db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)');
  schemaInsert.run('schema_version', String(SCHEMA_VERSION));

  const now = nowIso();

  const insertParticipant = db.prepare(
    'INSERT OR REPLACE INTO participants (key, name, type, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'
  );
  for (const p of spec.participants) {
    insertParticipant.run(p.key, p.name, p.type, now, now);
  }

  const insertMember = db.prepare(
    'INSERT OR IGNORE INTO conversation_members (conversation, participant_key, joined_at) VALUES (?, ?, ?)'
  );
  for (const ch of spec.channels) {
    for (const key of ch.members ?? []) {
      insertMember.run(ch.name, key, now);
    }
  }

  const insertRole = db.prepare(
    'INSERT OR REPLACE INTO conversation_roles (conversation, participant_key, role, granted_at) VALUES (?, ?, ?, ?)'
  );
  for (const r of spec.roles) {
    insertRole.run(r.conversation, r.participantKey, r.role, now);
  }

  db.close();
}

/**
 * Write {dataDir}/conversations/<name>/meta.json for every seeded channel.
 * Schema mirrors ConversationMeta in src/claude_comms/conversation.py.
 */
async function writeChannelMeta(dataDir: string, spec: SeedSpec): Promise<void> {
  const convRoot = join(dataDir, 'conversations');
  for (const ch of spec.channels) {
    const dir = join(convRoot, ch.name);
    await mkdir(dir, { recursive: true });
    const meta = {
      name: ch.name,
      topic: ch.topic ?? '',
      created_by: ch.created_by,
      created_at: nowIso(),
      last_activity: nowIso(),
      archived: ch.archived ?? false,
      deleted_at: null,
      deleted_by: null,
      archived_at: null,
      archived_by: null,
      visibility: ch.visibility ?? 'public',
      mode: ch.mode ?? 'open',
      display_name: null,
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }
}

/**
 * Write {dataDir}/logs/<name>.jsonl per channel. Format mirrors what
 * broker.replay_jsonl_logs reads: one JSON object per line, must have
 * `id`, `conv`, `ts`, `sender`, `body`.
 */
async function writeMessageLogs(dataDir: string, spec: SeedSpec): Promise<void> {
  const logDir = join(dataDir, 'logs');
  await mkdir(logDir, { recursive: true });

  const byChannel = new Map<string, SeedMessage[]>();
  for (const m of spec.messages) {
    if (!byChannel.has(m.conv)) byChannel.set(m.conv, []);
    byChannel.get(m.conv)!.push(m);
  }

  for (const [chName, msgs] of byChannel) {
    const timestamps = makeMessageTimestamps(msgs.length);
    const lines: string[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const ts = m.ts ?? timestamps[i];
      const obj = {
        id: randomUUID(),
        ts,
        sender: {
          key: m.sender.key,
          name: m.sender.name,
          type: m.sender.type,
        },
        body: m.body,
        conv: m.conv,
        recipients: null as string[] | null,
        reply_to: m.reply_to ?? null,
        thread_root: m.thread_root ?? null,
        message_type: m.messageType ?? 'chat',
      };
      lines.push(JSON.stringify(obj));
    }
    await writeFile(join(logDir, `${chName}.jsonl`), lines.join('\n') + '\n');
  }
}

/**
 * Seed the daemon's data directory with participants, channels, roles, and
 * messages. Must be called BEFORE the daemon process starts so the registry
 * rehydrates from disk + the broker replays the JSONL log.
 *
 * @param home  the isolated HOME assigned by spawnDaemon (test-tmp dir).
 * @param spec  the data shape to seed.
 */
export async function seedDataDir(home: string, spec: SeedSpec): Promise<void> {
  const dataDir = join(home, '.claude-comms');
  await mkdir(dataDir, { recursive: true });

  writeRegistryDb(join(dataDir, 'registry.db'), spec);
  await writeChannelMeta(dataDir, spec);
  await writeMessageLogs(dataDir, spec);
}

// ---------------------------------------------------------------------------
// Canonical seed bundle used by scenario 01 + the Phase 2 default.
// ---------------------------------------------------------------------------

export const PHIL: SeedParticipant = { key: 'aaaaaaaa', name: 'phil', type: 'human' };
export const CLAUDE: SeedParticipant = { key: 'bbbbbbbb', name: 'claude', type: 'claude' };
export const BOT: SeedParticipant = { key: 'cccccccc', name: 'bot', type: 'claude' };

/**
 * The canonical Phase 1 seed:
 *  - 3 participants
 *  - 4 channels:
 *      general       — public/open, all members; 6 mixed messages
 *      dev-chat      — public/open, phil owner, claude member; 4 messages
 *      private-room  — private/invite, phil owner only; 2 messages
 *      legacy-empty  — public/open, no members, no messages
 */
export function canonicalSeed(): SeedSpec {
  const participants: SeedParticipant[] = [PHIL, CLAUDE, BOT];

  const channels: SeedChannel[] = [
    {
      name: 'general',
      topic: 'Open lobby for everyone',
      created_by: 'system',
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key, CLAUDE.key, BOT.key],
    },
    {
      name: 'dev-chat',
      topic: 'Dev questions and answers',
      created_by: PHIL.name,
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key, CLAUDE.key],
    },
    {
      name: 'private-room',
      topic: 'Phil-only sandbox',
      created_by: PHIL.name,
      visibility: 'private',
      mode: 'invite',
      members: [PHIL.key],
    },
    {
      name: 'legacy-empty',
      topic: '',
      created_by: 'system-backfill',
      visibility: 'public',
      mode: 'open',
      members: [],
    },
  ];

  const roles: SeedRole[] = [
    { conversation: 'general', participantKey: PHIL.key, role: 'member' },
    { conversation: 'dev-chat', participantKey: PHIL.key, role: 'owner' },
    { conversation: 'dev-chat', participantKey: CLAUDE.key, role: 'member' },
    { conversation: 'private-room', participantKey: PHIL.key, role: 'owner' },
  ];

  const systemSender = { key: '00000000', name: 'system', type: 'system' as const };

  const generalMsgs: SeedMessage[] = [
    { conv: 'general', sender: systemSender, body: '[system] phil joined #general', messageType: 'system' },
    { conv: 'general', sender: PHIL, body: 'morning team' },
    { conv: 'general', sender: CLAUDE, body: 'good morning phil' },
    { conv: 'general', sender: BOT, body: 'beep boop status: nominal' },
    { conv: 'general', sender: PHIL, body: 'shipping the v0.4.3 e2e suite today' },
    { conv: 'general', sender: CLAUDE, body: 'on it' },
  ];

  const devRootId = randomUUID();
  const devChatMsgs: SeedMessage[] = [
    { conv: 'dev-chat', sender: PHIL, body: 'how do you mock daemon state?' },
    { conv: 'dev-chat', sender: CLAUDE, body: 'isolated HOME + seed sqlite directly' },
    { conv: 'dev-chat', sender: PHIL, body: 'ack', thread_root: devRootId },
    { conv: 'dev-chat', sender: CLAUDE, body: 'reply to ack', reply_to: devRootId, thread_root: devRootId },
  ];

  const privateMsgs: SeedMessage[] = [
    { conv: 'private-room', sender: PHIL, body: 'first thought' },
    { conv: 'private-room', sender: PHIL, body: 'second thought' },
  ];

  return {
    participants,
    channels,
    roles,
    messages: [...generalMsgs, ...devChatMsgs, ...privateMsgs],
  };
}
