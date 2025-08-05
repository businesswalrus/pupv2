import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger';

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

    // Enable foreign keys
    await runQuery('PRAGMA foreign_keys = ON');
    
    // Run migrations
    await createTables();
    
    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error('Database initialization failed', error);
    throw error;
  }
}

async function createTables(): Promise<void> {
  // For now, just create a simple interactions table to track costs
  const createInteractionsTable = `
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      operation_type TEXT NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      cost_usd DECIMAL(10,6) DEFAULT 0,
      model_used TEXT,
      success BOOLEAN DEFAULT 1,
      error_message TEXT
    )
  `;

  await runQuery(createInteractionsTable);
  logger.info('Database tables created/verified');
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