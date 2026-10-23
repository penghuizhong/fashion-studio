export function migrateCanvas(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_agent_workflows (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_agent_quotes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_agent_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
      quote_id TEXT NOT NULL UNIQUE, request_key TEXT NOT NULL,
      status TEXT NOT NULL, input_json TEXT NOT NULL, messages_json TEXT NOT NULL DEFAULT '[]',
      result_json TEXT NOT NULL DEFAULT '{}', reserved INTEGER NOT NULL DEFAULT 0,
      settled INTEGER NOT NULL DEFAULT 0, stop_requested INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS canvas_agent_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES canvas_agent_runs(id),
      sequence INTEGER NOT NULL, kind TEXT NOT NULL, tool TEXT NOT NULL,
      status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT NOT NULL DEFAULT '{}',
      child_run_id TEXT REFERENCES canvas_runs(id), charge INTEGER NOT NULL DEFAULT 0,
      UNIQUE(run_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS canvas_agent_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES canvas_agent_runs(id),
      type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
      snapshot_json TEXT, revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS canvas_projects_owner ON canvas_projects(user_id,updated_at);
    CREATE TABLE IF NOT EXISTS canvas_assets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      image_path TEXT NOT NULL, thumb_path TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      origin TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,image_path)
    );
    CREATE TABLE IF NOT EXISTS canvas_project_assets (
      project_id TEXT NOT NULL REFERENCES canvas_projects(id),
      asset_id TEXT NOT NULL REFERENCES canvas_assets(id),
      PRIMARY KEY(project_id,asset_id)
    );
    CREATE TABLE IF NOT EXISTS canvas_brand_kits (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      definition_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_shares (
      token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES canvas_projects(id),
      user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_quotes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES canvas_projects(id), user_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES canvas_projects(id), user_id TEXT NOT NULL,
      request_key TEXT NOT NULL, quote_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      input_json TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}',
      reserved INTEGER NOT NULL DEFAULT 0, settled INTEGER NOT NULL DEFAULT 0,
      delivered INTEGER NOT NULL DEFAULT 0, stop_requested INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id,request_key)
    );
    CREATE INDEX IF NOT EXISTS canvas_runs_queue ON canvas_runs(status,created_at);
    CREATE TABLE IF NOT EXISTS canvas_asset_events (
      run_id TEXT NOT NULL REFERENCES canvas_runs(id), source_asset_id TEXT NOT NULL REFERENCES canvas_assets(id),
      result_asset_id TEXT NOT NULL REFERENCES canvas_assets(id), PRIMARY KEY(run_id,source_asset_id,result_asset_id)
    );
    CREATE TABLE IF NOT EXISTS canvas_batches (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES canvas_projects(id), user_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'quoted',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_batch_runs (
      batch_id TEXT NOT NULL REFERENCES canvas_batches(id), run_id TEXT NOT NULL UNIQUE REFERENCES canvas_runs(id),
      PRIMARY KEY(batch_id,run_id)
    );
    CREATE TABLE IF NOT EXISTS canvas_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES canvas_runs(id), sequence INTEGER NOT NULL,
      tool TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(run_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS canvas_recipes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES canvas_runs(id),
      title TEXT NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,run_id)
    );
  `);
  if (!db.prepare('PRAGMA table_info(canvas_runs)').all().some(c=>c.name==='delivered')) db.exec('ALTER TABLE canvas_runs ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0');
}
