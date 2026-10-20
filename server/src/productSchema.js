import fs from 'node:fs';
import path from 'node:path';
export function migrateProducts(db, dataDir) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_records'").get()) return;
  if (db.prepare('SELECT COUNT(*) n FROM style_dna_templates').get().n) {
    const dir=path.join(dataDir,'backups');fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,`pre-product-ecosystem-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${file.replaceAll("'","''")}'`);
  }
  db.transaction(()=>db.exec(`
    CREATE TABLE product_records(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,project_id TEXT,template_id INTEGER,revision INTEGER NOT NULL,lifecycle TEXT NOT NULL DEFAULT 'active',state TEXT NOT NULL DEFAULT 'draft',payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX product_record_owner ON product_records(user_id,kind,updated_at);
    CREATE INDEX product_record_project ON product_records(project_id,kind,updated_at);
    CREATE UNIQUE INDEX product_one_project ON product_records(template_id,user_id) WHERE kind='project';
    CREATE TABLE product_history(record_id TEXT NOT NULL,revision INTEGER NOT NULL,user_id TEXT NOT NULL,action TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,lifecycle TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(record_id,revision));
    CREATE TRIGGER immutable_product_history BEFORE UPDATE ON product_history BEGIN SELECT RAISE(ABORT,'Product history is immutable'); END;
    CREATE TABLE product_requests(user_id TEXT NOT NULL,request_key TEXT NOT NULL,signature TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(user_id,request_key));
    CREATE TABLE product_files(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,path TEXT NOT NULL,thumb_path TEXT,name TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE product_file_refs(record_id TEXT NOT NULL,revision INTEGER NOT NULL,user_id TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(record_id,revision,path));
    CREATE INDEX product_file_path ON product_file_refs(path,user_id);
  `))();
}
