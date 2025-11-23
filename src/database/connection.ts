import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import * as sqliteVec from 'sqlite-vec';

// Database path - Railway will mount persistent storage at /data
const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || './data/pup.db';
const DB_DIR = path.dirname(DB_PATH);

let db: sqlite3.Database;

export async function initializeDatabase(): Promise<void> {
  try {
    // Ensure data directory exists
    await fs.mkdir(DB_DIR, { recursive: true });
    logger.info(`Database directory ensured at: ${DB_DIR}`);

    // Open database connection
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logger.error('Failed to open database', err);
        throw err;
      }
      logger.info(`Connected to SQLite database at: ${DB_PATH}`);
    });

    // Load sqlite-vec extension for vector operations
    await new Promise<void>((resolve, reject) => {
      sqliteVec.load(db, (err) => {
        if (err) {
          logger.error('Failed to load sqlite-vec extension', err);
          reject(err);
        } else {
          logger.info('sqlite-vec extension loaded successfully');
          resolve();
        }
      });
    });

    // Enable foreign keys and other pragmas
    await runQuery('PRAGMA foreign_keys = ON');
    await runQuery('PRAGMA journal_mode = WAL'); // Better concurrency
    await runQuery('PRAGMA synchronous = NORMAL'); // Balance safety and speed

    // Run migrations
    await createTables();

    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error('Database initialization failed', error);
    throw error;
  }
}

async function createTables(): Promise<void> {
  logger.info('Creating/verifying database schema...');

  // Table 1: Users - Track user profiles and personality
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      slack_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      personality_traits TEXT, -- JSON blob
      speech_patterns TEXT, -- JSON blob
      activity_patterns TEXT, -- JSON blob
      relationship_summary TEXT,
      last_seen DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // Table 2: Memories - Core memory storage with vector embeddings
  const createMemoriesTable = `
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT CHECK(type IN ('joke', 'fact', 'moment', 'preference', 'relationship', 'quote')),
      channel_id TEXT NOT NULL,
      user_id TEXT,
      embedding BLOB, -- 1536-dim vector from OpenAI
      metadata TEXT, -- JSON blob for additional context
      significance_score REAL CHECK(significance_score BETWEEN 0 AND 1),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      reference_count INTEGER DEFAULT 0,
      searchable_text TEXT NOT NULL,
      tags TEXT, -- JSON array
      context TEXT, -- Surrounding conversation
      participants TEXT, -- JSON array of user IDs
      FOREIGN KEY (user_id) REFERENCES users(slack_id) ON DELETE SET NULL
    )
  `;

  // Table 3: Relationships - Track user interaction dynamics
  const createRelationshipsTable = `
    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      user1_id TEXT NOT NULL,
      user2_id TEXT NOT NULL,
      relationship_type TEXT CHECK(relationship_type IN ('friendship', 'rivalry', 'mentorship', 'romance', 'collaborative')),
      strength REAL CHECK(strength BETWEEN 0 AND 1),
      dynamics TEXT, -- JSON blob
      last_interaction DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user1_id) REFERENCES users(slack_id) ON DELETE CASCADE,
      FOREIGN KEY (user2_id) REFERENCES users(slack_id) ON DELETE CASCADE,
      UNIQUE(user1_id, user2_id)
    )
  `;

  // Table 4: Channel Vibes - Channel-specific behavior profiles
  const createChannelVibesTable = `
    CREATE TABLE IF NOT EXISTS channel_vibes (
      id TEXT PRIMARY KEY,
      channel_id TEXT UNIQUE NOT NULL,
      channel_name TEXT,
      vibe_description TEXT,
      typical_topics TEXT, -- JSON array
      formality_level REAL CHECK(formality_level BETWEEN 0 AND 1),
      humor_tolerance REAL CHECK(humor_tolerance BETWEEN 0 AND 1),
      response_frequency REAL CHECK(response_frequency BETWEEN 0 AND 1),
      custom_rules TEXT, -- JSON blob
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // Table 5: Interactions - Cost and usage tracking
  const createInteractionsTable = `
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      operation_type TEXT NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      cost_usd DECIMAL(10,6) DEFAULT 0,
      model_used TEXT,
      success BOOLEAN DEFAULT 1,
      error_message TEXT,
      channel_id TEXT,
      user_id TEXT
    )
  `;

  // Create all tables
  await runQuery(createUsersTable);
  await runQuery(createMemoriesTable);
  await runQuery(createRelationshipsTable);
  await runQuery(createChannelVibesTable);
  await runQuery(createInteractionsTable);

  // Create indexes for performance
  await runQuery('CREATE INDEX IF NOT EXISTS idx_memories_channel ON memories(channel_id)');
  await runQuery('CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)');
  await runQuery('CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC)');
  await runQuery('CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at)');
  await runQuery('CREATE INDEX IF NOT EXISTS idx_memories_significance ON memories(significance_score DESC)');

  await runQuery('CREATE INDEX IF NOT EXISTS idx_users_slack_id ON users(slack_id)');
  await runQuery('CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen DESC)');

  await runQuery('CREATE INDEX IF NOT EXISTS idx_relationships_user1 ON relationships(user1_id)');
  await runQuery('CREATE INDEX IF NOT EXISTS idx_relationships_user2 ON relationships(user2_id)');

  await runQuery('CREATE INDEX IF NOT EXISTS idx_channel_vibes_channel ON channel_vibes(channel_id)');

  await runQuery('CREATE INDEX IF NOT EXISTS idx_interactions_timestamp ON interactions(timestamp DESC)');
  await runQuery('CREATE INDEX IF NOT EXISTS idx_interactions_channel ON interactions(channel_id)');

  // Create virtual table for vector similarity search on memory embeddings
  // Using vec0 for 1536-dimensional OpenAI embeddings
  await runQuery(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding FLOAT[1536]
    )
  `);

  logger.info('Database schema created/verified successfully');
  logger.info('Tables: users, memories, relationships, channel_vibes, interactions');
  logger.info('Vector search: vec_memories (1536-dim embeddings)');
}

// Helper functions for database operations
export function runQuery(query: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this);
      }
    });
  });
}

export function getQuery(query: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

export function allQuery(query: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

export function getDb(): sqlite3.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

// Cleanup function for expired memories
export async function cleanupExpiredMemories(): Promise<number> {
  const result = await runQuery(
    'DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime("now")'
  );
  return result.changes || 0;
}

// Get database statistics
export async function getDatabaseStats(): Promise<any> {
  const [users, memories, relationships, channels, interactions] = await Promise.all([
    getQuery('SELECT COUNT(*) as count FROM users'),
    getQuery('SELECT COUNT(*) as count FROM memories'),
    getQuery('SELECT COUNT(*) as count FROM relationships'),
    getQuery('SELECT COUNT(*) as count FROM channel_vibes'),
    getQuery('SELECT COUNT(*) as count FROM interactions')
  ]);

  return {
    users: users.count,
    memories: memories.count,
    relationships: relationships.count,
    channels: channels.count,
    interactions: interactions.count
  };
}