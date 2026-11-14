import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS user_links (
      ss_user_id   TEXT PRIMARY KEY,
      wh_user_id   TEXT NOT NULL,
      email        TEXT NOT NULL,
      full_name    TEXT,
      token_enc    TEXT NOT NULL,
      wh_workspace_id TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_links (
      ss_project_id TEXT PRIMARY KEY,
      owner_ss_user_id TEXT NOT NULL,
      wh_workspace_id TEXT NOT NULL,
      wh_team_id    TEXT NOT NULL,
      wh_project_id TEXT NOT NULL,
      wh_project_key TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      last_synced_at TEXT,
      last_version  TEXT
    );
    CREATE TABLE IF NOT EXISTS entity_links (
      ss_project_id TEXT NOT NULL,
      kind          TEXT NOT NULL,         -- 'module' | 'usecase'
      ss_key        TEXT NOT NULL,         -- module slug or use case lineage key
      wh_issue_id   TEXT NOT NULL,
      wh_key        TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      wh_status     TEXT,
      wh_assignee   TEXT,
      wh_sprint     TEXT,
      wh_blocked    INTEGER NOT NULL DEFAULT 0,
      removed       INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (ss_project_id, kind, ss_key)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_issue ON entity_links (wh_issue_id);
    CREATE TABLE IF NOT EXISTS member_links (
      ss_project_id TEXT NOT NULL,
      email         TEXT NOT NULL,
      wh_user_id    TEXT,
      wh_invitation_id TEXT,
      PRIMARY KEY (ss_project_id, email)
    );
    CREATE TABLE IF NOT EXISTS design_links (
      ss_project_id TEXT NOT NULL,
      doc_key       TEXT NOT NULL,         -- kind:slug, stable across versions
      wh_doc_id     TEXT NOT NULL,
      title         TEXT NOT NULL,
      doc_type      TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      use_case_keys TEXT NOT NULL DEFAULT '[]',
      linked_issues TEXT NOT NULL DEFAULT '[]',
      archived      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ss_project_id, doc_key)
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      ss_project_id TEXT,
      direction TEXT NOT NULL,
      summary TEXT NOT NULL
    );
  `);
  const addColumns = (table: string, cols: string[]) => {
    for (const col of cols) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* column exists */ }
    }
  };
  addColumns('entity_links', ['spec_json TEXT', 'progress_json TEXT']);
  addColumns('project_links', ['paused INTEGER NOT NULL DEFAULT 0', 'archived INTEGER NOT NULL DEFAULT 0', 'wh_prev_status TEXT']);
  addColumns('user_links', ['token_id TEXT']);
  addColumns('project_links', ['base_name TEXT', 'base_desc TEXT']); // last name/description both systems agreed on (three-way merge)
  return db;
}
