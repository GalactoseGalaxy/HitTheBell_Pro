import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      paddle_customer_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'trial',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      uploads_playlist_id TEXT,
      latest_video_id TEXT,
      latest_video_title TEXT,
      latest_video_thumbnail TEXT,
      latest_video_upload_date TIMESTAMPTZ,
      latest_video_duration TEXT,
      last_seen_video_id TEXT,
      last_checked_at TIMESTAMPTZ,
      last_changed_at TIMESTAMPTZ,
      metadata_last_checked_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (customer_id, channel_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS restore_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS paid_through TIMESTAMPTZ;
  `);
}

export function getPool() {
  return pool;
}
