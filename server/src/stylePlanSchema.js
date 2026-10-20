export function migrateStylePlans(db) {
  db.transaction(() =>
    db.exec(`
 CREATE TABLE IF NOT EXISTS style_plans(id TEXT PRIMARY KEY,template_id INTEGER NOT NULL,user_id TEXT NOT NULL,version_id INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,input_json TEXT NOT NULL,content_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_style_plans_owner ON style_plans(user_id,template_id,updated_at DESC);
 CREATE TABLE IF NOT EXISTS style_plan_revisions(plan_id TEXT NOT NULL,revision INTEGER NOT NULL,input_json TEXT NOT NULL,content_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(plan_id,revision));
 CREATE TABLE IF NOT EXISTS style_plan_requests(template_id INTEGER NOT NULL,user_id TEXT NOT NULL,request_key TEXT NOT NULL,signature TEXT NOT NULL,plan_id TEXT NOT NULL,PRIMARY KEY(user_id,request_key));
 CREATE TABLE IF NOT EXISTS style_plan_analyses(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,revision INTEGER NOT NULL,scope_json TEXT NOT NULL,status TEXT NOT NULL,progress_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
 `),
  )();
}
