import { Pool } from "pg";
import { logger } from "./logger";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      html_report TEXT,
      stats_json TEXT,
      report_meta JSONB,
      report_summary TEXT,
      orgs TEXT[],
      date_from TEXT,
      date_to TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Migration: add report_summary column if missing (deployed DBs created before this column)
  await pool.query(`
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_summary TEXT;
  `).catch(() => { /* ignore if table doesn't exist yet (handled by CREATE TABLE) */ });
  logger.info("Database schema initialised");
}
