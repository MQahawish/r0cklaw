/**
 * server/db.ts
 * SQLite schema and connection. Drop-in replacement for the Convex backend DB.
 *
 * Design notes:
 * - All Convex `v.id('table')` become TEXT primary keys (nanoid).
 * - Complex nested objects (aiTown world state) are stored as JSON TEXT.
 * - All rl_* (Rocklaw) tables use proper typed columns.
 * - A `_id` column is the primary key on every table, matching Convex's _id field.
 * - A `_creationTime` column (unix ms) matches Convex's implicit _creationTime.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;
  const resolvedPath = dbPath ?? path.join(__dirname, '..', 'data', 'rocklaw.db');
  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

export function closeDb() {
  _db?.close();
  _db = null;
}

function initSchema(db: Database.Database) {
  db.exec(`
    -- ─────────────────────────────────────────────
    -- Internal scheduler table
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS _scheduler (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      fnName           TEXT NOT NULL,
      argsJson         TEXT NOT NULL,
      runAtMs          REAL NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS _scheduler_runAt ON _scheduler(runAtMs, status);

    -- ─────────────────────────────────────────────
    -- music
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS music (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      storageId        TEXT NOT NULL,
      type             TEXT NOT NULL
    );

    -- ─────────────────────────────────────────────
    -- messages  (aiTown chat messages)
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      conversationId   TEXT NOT NULL,
      messageUuid      TEXT NOT NULL,
      author           TEXT NOT NULL,
      text             TEXT NOT NULL,
      worldId          TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_conversationId ON messages(worldId, conversationId);
    CREATE INDEX IF NOT EXISTS messages_messageUuid    ON messages(conversationId, messageUuid);

    -- ─────────────────────────────────────────────
    -- Agent memory tables (aiTown)
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS memories (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      playerId         TEXT NOT NULL,
      description      TEXT NOT NULL,
      embeddingId      TEXT NOT NULL,
      importance       REAL NOT NULL,
      lastAccess       REAL NOT NULL,
      dataJson         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_embeddingId   ON memories(embeddingId);
    CREATE INDEX IF NOT EXISTS memories_playerId_type ON memories(playerId, json_extract(dataJson,'$.type'));
    CREATE INDEX IF NOT EXISTS memories_playerId      ON memories(playerId);

    CREATE TABLE IF NOT EXISTS memoryEmbeddings (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      playerId         TEXT NOT NULL,
      embeddingJson    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embeddingsCache (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      textHash         TEXT NOT NULL,
      embeddingJson    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS embeddingsCache_text ON embeddingsCache(textHash);

    -- ─────────────────────────────────────────────
    -- Engine tables
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS engines (
      _id                    TEXT PRIMARY KEY,
      _creationTime          REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      currentTime            REAL,
      lastStepTs             REAL,
      processedInputNumber   REAL,
      running                INTEGER NOT NULL DEFAULT 0,
      generationNumber       REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS inputs (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      engineId         TEXT NOT NULL,
      number           REAL NOT NULL,
      name             TEXT NOT NULL,
      argsJson         TEXT NOT NULL,
      returnValueJson  TEXT,
      received         REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inputs_byInputNumber ON inputs(engineId, number);

    -- ─────────────────────────────────────────────
    -- aiTown world tables  (stored as JSON blobs)
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS worlds (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      dataJson         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worldStatus (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      worldId          TEXT NOT NULL,
      isDefault        INTEGER NOT NULL DEFAULT 0,
      engineId         TEXT NOT NULL,
      lastViewed       REAL NOT NULL,
      status           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worldStatus_worldId ON worldStatus(worldId);

    CREATE TABLE IF NOT EXISTS maps (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      worldId          TEXT NOT NULL,
      dataJson         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS maps_worldId ON maps(worldId);

    CREATE TABLE IF NOT EXISTS playerDescriptions (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      worldId          TEXT NOT NULL,
      playerId         TEXT NOT NULL,
      dataJson         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS playerDescriptions_worldId ON playerDescriptions(worldId, playerId);

    CREATE TABLE IF NOT EXISTS agentDescriptions (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      worldId          TEXT NOT NULL,
      agentId          TEXT NOT NULL,
      dataJson         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agentDescriptions_worldId ON agentDescriptions(worldId, agentId);

    CREATE TABLE IF NOT EXISTS archivedPlayers (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      worldId          TEXT NOT NULL,
      playerId         TEXT NOT NULL,
      dataJson         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS archivedPlayers_worldId ON archivedPlayers(worldId, playerId);

    CREATE TABLE IF NOT EXISTS archivedConversations (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      worldId          TEXT NOT NULL,
      id               TEXT NOT NULL,
      creator          TEXT NOT NULL,
      created          REAL NOT NULL,
      ended            REAL NOT NULL,
      lastMessageJson  TEXT,
      numMessages      REAL NOT NULL DEFAULT 0,
      participantsJson TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS archivedConversations_worldId ON archivedConversations(worldId, id);

    CREATE TABLE IF NOT EXISTS archivedAgents (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      worldId          TEXT NOT NULL,
      agentId          TEXT NOT NULL,
      dataJson         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS archivedAgents_worldId ON archivedAgents(worldId, agentId);

    CREATE TABLE IF NOT EXISTS participatedTogether (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      worldId          TEXT NOT NULL,
      conversationId   TEXT NOT NULL,
      player1          TEXT NOT NULL,
      player2          TEXT NOT NULL,
      ended            REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS participatedTogether_edge         ON participatedTogether(worldId, player1, player2, ended);
    CREATE INDEX IF NOT EXISTS participatedTogether_conversation ON participatedTogether(worldId, player1, conversationId);
    CREATE INDEX IF NOT EXISTS participatedTogether_playerHistory ON participatedTogether(worldId, player1, ended);

    -- ─────────────────────────────────────────────
    -- Rocklaw core tables  (rl_*)
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rl_agents (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      name             TEXT NOT NULL,
      role             TEXT NOT NULL,
      location         TEXT NOT NULL,
      inventory        TEXT NOT NULL DEFAULT '{}',
      energy           REAL NOT NULL DEFAULT 100,
      health           REAL NOT NULL DEFAULT 100,
      hunger           REAL NOT NULL DEFAULT 0,
      coin             REAL NOT NULL DEFAULT 0,
      gatewayPort      INTEGER NOT NULL,
      workspacePath    TEXT NOT NULL,
      currentDay       INTEGER NOT NULL DEFAULT 1,
      busy             INTEGER NOT NULL DEFAULT 0,
      busyUntilTick    INTEGER,
      pendingNote      TEXT,
      blankSelf        INTEGER,
      paused           INTEGER,
      modelOverride    TEXT,
      providerOverride TEXT
    );
    CREATE INDEX IF NOT EXISTS rl_agents_name     ON rl_agents(name);
    CREATE INDEX IF NOT EXISTS rl_agents_location ON rl_agents(location);

    CREATE TABLE IF NOT EXISTS rl_market_prices (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      item             TEXT NOT NULL,
      price            REAL NOT NULL,
      basePrice        REAL NOT NULL,
      changePct        REAL NOT NULL DEFAULT 0,
      shortageLevel    TEXT NOT NULL DEFAULT 'none',
      lastUpdated      REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rl_market_prices_item ON rl_market_prices(item);

    CREATE TABLE IF NOT EXISTS rl_messages (
      _id                TEXT PRIMARY KEY,
      _creationTime      REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      fromAgent          TEXT NOT NULL,
      toAgent            TEXT NOT NULL,
      content            TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'unread',
      deliveryLocationId TEXT,
      daySent            INTEGER NOT NULL,
      dayRead            INTEGER,
      tickSent           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rl_messages_toAgent   ON rl_messages(toAgent, status);
    CREATE INDEX IF NOT EXISTS rl_messages_fromAgent ON rl_messages(fromAgent, daySent);

    CREATE TABLE IF NOT EXISTS rl_chat_messages (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      threadKey        TEXT NOT NULL,
      fromAgent        TEXT NOT NULL,
      toAgent          TEXT NOT NULL,
      text             TEXT NOT NULL,
      deliveryMode     TEXT NOT NULL DEFAULT 'live',
      status           TEXT NOT NULL DEFAULT 'unread',
      sentTick         INTEGER NOT NULL,
      sentDay          INTEGER NOT NULL,
      readTick         INTEGER,
      readDay          INTEGER
    );
    CREATE INDEX IF NOT EXISTS rl_chat_messages_thread    ON rl_chat_messages(threadKey, sentDay, sentTick);
    CREATE INDEX IF NOT EXISTS rl_chat_messages_recipient ON rl_chat_messages(toAgent, status, sentDay, sentTick);
    CREATE INDEX IF NOT EXISTS rl_chat_messages_recv_sent ON rl_chat_messages(toAgent, sentDay, sentTick);
    CREATE INDEX IF NOT EXISTS rl_chat_messages_sender    ON rl_chat_messages(fromAgent, sentDay, sentTick);

    CREATE TABLE IF NOT EXISTS rl_chat_scenes (
      _id                      TEXT PRIMARY KEY,
      _creationTime            REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      sceneId                  TEXT NOT NULL,
      agentA                   TEXT NOT NULL,
      agentB                   TEXT NOT NULL,
      location                 TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'pending',
      nextSpeaker              TEXT NOT NULL,
      lastSpeaker              TEXT,
      openingSpeaker           TEXT,
      openingText              TEXT,
      interruptedSpeaker       TEXT,
      interruptedText          TEXT,
      interruptedActionJson    TEXT,
      interruptedContextPending INTEGER,
      openedTick               INTEGER NOT NULL,
      openedDay                INTEGER NOT NULL,
      lastActiveTick           INTEGER NOT NULL,
      lastActiveDay            INTEGER NOT NULL,
      closeReason              TEXT,
      closedTick               INTEGER,
      closedDay                INTEGER
    );
    CREATE INDEX IF NOT EXISTS rl_chat_scenes_sceneId       ON rl_chat_scenes(sceneId);
    CREATE INDEX IF NOT EXISTS rl_chat_scenes_agentA_status ON rl_chat_scenes(agentA, status);
    CREATE INDEX IF NOT EXISTS rl_chat_scenes_agentB_status ON rl_chat_scenes(agentB, status);
    CREATE INDEX IF NOT EXISTS rl_chat_scenes_status_loc    ON rl_chat_scenes(status, location);

    CREATE TABLE IF NOT EXISTS rl_transactions (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      txnId            TEXT NOT NULL,
      fromAgent        TEXT NOT NULL,
      toAgent          TEXT NOT NULL,
      kind             TEXT NOT NULL,
      offerJson        TEXT NOT NULL,
      requestJson      TEXT NOT NULL,
      message          TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      createdTick      INTEGER NOT NULL,
      createdDay       INTEGER NOT NULL,
      expiresTick      INTEGER NOT NULL,
      resolvedTick     INTEGER,
      resolvedDay      INTEGER,
      outcomeNote      TEXT
    );
    CREATE INDEX IF NOT EXISTS rl_transactions_txnId        ON rl_transactions(txnId);
    CREATE INDEX IF NOT EXISTS rl_transactions_recipient    ON rl_transactions(toAgent, status);
    CREATE INDEX IF NOT EXISTS rl_transactions_sender       ON rl_transactions(fromAgent, status);
    CREATE INDEX IF NOT EXISTS rl_transactions_status_exp  ON rl_transactions(status, expiresTick);

    CREATE TABLE IF NOT EXISTS rl_interactions (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      interactionId    TEXT NOT NULL,
      kind             TEXT NOT NULL,
      fromAgent        TEXT NOT NULL,
      toAgent          TEXT NOT NULL,
      location         TEXT NOT NULL,
      payloadJson      TEXT NOT NULL,
      transactionId    TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      createdTick      INTEGER NOT NULL,
      createdDay       INTEGER NOT NULL,
      expiresTick      INTEGER NOT NULL,
      resolvedTick     INTEGER,
      resolvedDay      INTEGER,
      outcomeNote      TEXT
    );
    CREATE INDEX IF NOT EXISTS rl_interactions_interactionId ON rl_interactions(interactionId);
    CREATE INDEX IF NOT EXISTS rl_interactions_recipient     ON rl_interactions(toAgent, status);
    CREATE INDEX IF NOT EXISTS rl_interactions_sender        ON rl_interactions(fromAgent, status);
    CREATE INDEX IF NOT EXISTS rl_interactions_status_exp   ON rl_interactions(status, expiresTick);
    CREATE INDEX IF NOT EXISTS rl_interactions_txnId        ON rl_interactions(transactionId);

    CREATE TABLE IF NOT EXISTS rl_social_knowledge (
      _id                  TEXT PRIMARY KEY,
      _creationTime        REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      observerAgent        TEXT NOT NULL,
      subjectAgent         TEXT NOT NULL,
      knownName            TEXT NOT NULL,
      knownRole            TEXT NOT NULL,
      firstSeenDay         INTEGER NOT NULL,
      firstSeenTick        INTEGER NOT NULL,
      firstSeenLocation    TEXT NOT NULL,
      lastSeenDay          INTEGER NOT NULL,
      lastSeenTick         INTEGER NOT NULL,
      lastSeenLocation     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rl_social_knowledge_obs_sub ON rl_social_knowledge(observerAgent, subjectAgent);
    CREATE INDEX IF NOT EXISTS rl_social_knowledge_obs     ON rl_social_knowledge(observerAgent);

    CREATE TABLE IF NOT EXISTS rl_fields (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      fieldKey         TEXT NOT NULL,
      location         TEXT NOT NULL,
      cropItem         TEXT,
      stage            TEXT NOT NULL DEFAULT 'fallow',
      readyTick        INTEGER
    );
    CREATE INDEX IF NOT EXISTS rl_fields_fieldKey ON rl_fields(fieldKey);
    CREATE INDEX IF NOT EXISTS rl_fields_location ON rl_fields(location);

    CREATE TABLE IF NOT EXISTS rl_herb_patches (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      patchKey         TEXT NOT NULL,
      location         TEXT NOT NULL,
      herbItem         TEXT NOT NULL,
      available        REAL NOT NULL DEFAULT 0,
      maxAvailable     REAL NOT NULL DEFAULT 10,
      regenPerDay      REAL NOT NULL DEFAULT 1,
      lastRegenDay     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS rl_herb_patches_patchKey ON rl_herb_patches(patchKey);
    CREATE INDEX IF NOT EXISTS rl_herb_patches_location ON rl_herb_patches(location);

    CREATE TABLE IF NOT EXISTS rl_locations (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      name             TEXT NOT NULL,
      type             TEXT NOT NULL,
      capacity         INTEGER NOT NULL DEFAULT 10,
      presentAgents    TEXT NOT NULL DEFAULT '[]',
      messageBoard     TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS rl_locations_name ON rl_locations(name);

    CREATE TABLE IF NOT EXISTS rl_world_events (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      type             TEXT NOT NULL,
      description      TEXT NOT NULL,
      severity         TEXT NOT NULL DEFAULT 'low',
      active           INTEGER NOT NULL DEFAULT 1,
      source           TEXT NOT NULL DEFAULT 'god',
      createdAtTick    INTEGER NOT NULL,
      resolvedAtTick   INTEGER
    );
    CREATE INDEX IF NOT EXISTS rl_world_events_active ON rl_world_events(active, createdAtTick);

    CREATE TABLE IF NOT EXISTS rl_actions_log (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      agentName        TEXT NOT NULL,
      action           TEXT NOT NULL,
      target           TEXT,
      location         TEXT,
      message          TEXT,
      tick             INTEGER NOT NULL,
      day              INTEGER NOT NULL,
      outcome          TEXT NOT NULL DEFAULT 'success',
      outcomeNote      TEXT
    );
    CREATE INDEX IF NOT EXISTS rl_actions_log_agentName ON rl_actions_log(agentName, tick);
    CREATE INDEX IF NOT EXISTS rl_actions_log_tick      ON rl_actions_log(tick);

    CREATE TABLE IF NOT EXISTS rl_prayers (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      agentName        TEXT NOT NULL,
      message          TEXT NOT NULL,
      tick             INTEGER NOT NULL,
      day              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rl_prayers_agentName ON rl_prayers(agentName, tick);

    CREATE TABLE IF NOT EXISTS rl_reputation (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      agentName        TEXT NOT NULL,
      score            REAL NOT NULL DEFAULT 50,
      recentIncidents  TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS rl_reputation_agentName ON rl_reputation(agentName);

    CREATE TABLE IF NOT EXISTS rl_world_state (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      tick             INTEGER NOT NULL DEFAULT 0,
      day              INTEGER NOT NULL DEFAULT 1,
      timeOfDay        TEXT NOT NULL DEFAULT 'morning',
      isRunning        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS rl_price_history (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      tick             INTEGER NOT NULL,
      day              INTEGER NOT NULL,
      item             TEXT NOT NULL,
      price            REAL NOT NULL,
      shortageLevel    TEXT NOT NULL DEFAULT 'none'
    );
    CREATE INDEX IF NOT EXISTS rl_price_history_item_tick ON rl_price_history(item, tick);
    CREATE INDEX IF NOT EXISTS rl_price_history_tick      ON rl_price_history(tick);

    CREATE TABLE IF NOT EXISTS rl_systems_state (
      _id              TEXT PRIMARY KEY,
      _creationTime    REAL NOT NULL DEFAULT (unixepoch('now','subsec')*1000),
      systemName       TEXT NOT NULL,
      key              TEXT NOT NULL,
      value            TEXT NOT NULL,
      updatedAt        REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rl_systems_state_system ON rl_systems_state(systemName, key);
  `);
}
