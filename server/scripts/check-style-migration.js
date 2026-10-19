import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "style-migration-"),
);
process.env.MULTI_USER = "false";
process.env.MOCK_LLM = "true";
const { getDb, closeDb } = await import("../src/db.js");
let db = getDb();
const completeBackup = path.join(
  os.tmpdir(),
  `style-complete-backup-${Date.now()}`,
);
const stamp = new Date().toISOString();
try {
  const file = "uploads/studio/legacy-original.png";
  fs.mkdirSync(path.join(process.env.DATA_DIR, "uploads/studio"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(process.env.DATA_DIR, file),
    "unchanged historical original",
  );
  db.prepare(
    "INSERT INTO style_dna_templates(user_id,name,source_image_path,preset_id,dna_json,created_at,updated_at) VALUES('local','旧类目款式',?,'','{\"fabric\":{\"value\":\"羊毛\",\"confidence\":0.8}}',?,?)",
  ).run(file, stamp, stamp);
  const t = db.prepare("SELECT * FROM style_dna_templates").get();
  db.prepare(
    "INSERT INTO dna_generations(template_id,user_id,image_path,prompt_snapshot,created_at) VALUES(?,'local',?,'legacy prompt',?)",
  ).run(t.id, file, stamp);
  db.exec(
    "DROP TRIGGER immutable_style_attributes; DROP INDEX style_generation_item; DROP TABLE style_versions; DROP TABLE style_version_requests; DROP TABLE style_version_events; DROP TABLE style_references; DROP TABLE style_layouts;",
  );
  for (const [table, columns] of Object.entries({
    style_dna_templates: [
      "work_version_id",
      "cover_generation_id",
      "style_batch_id",
    ],
    dna_generations: [
      "design_version_id",
      "source_generation_id",
      "task_item_id",
      "settings_json",
    ],
    exploration_batches: ["workflow_kind"],
  }))
    for (const column of columns)
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  closeDb();
  if (!fs.existsSync(completeBackup))
    execFileSync(process.execPath, [
      fileURLToPath(new URL("./backup-style-upgrade.js", import.meta.url)),
      process.env.DATA_DIR,
      completeBackup,
    ]);
  db = getDb();
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM style_dna_templates").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM style_versions").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT design_version_id FROM dna_generations").get()
      .design_version_id,
    null,
  );
  assert.equal(
    fs.readFileSync(path.join(process.env.DATA_DIR, file), "utf8"),
    "unchanged historical original",
  );
  console.log(
    "PASS 1. legacy templates and original files survive migration; unknown image provenance remains unknown",
  );
  const backups = fs
    .readdirSync(path.join(process.env.DATA_DIR, "backups"))
    .filter((f) => f.endsWith(".db"));
  assert.equal(backups.length, 1);
  const backup = new Database(
    path.join(process.env.DATA_DIR, "backups", backups[0]),
    { readonly: true },
  );
  assert.equal(
    backup.prepare("SELECT dna_json FROM style_dna_templates").get().dna_json,
    db.prepare("SELECT dna_json FROM style_versions").get().dna_json,
  );
  backup.close();
  console.log(
    "PASS 2. pre-version database backup is readable and preserves old attributes",
  );
  closeDb();
  db = getDb();
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM style_versions").get().n,
    1,
  );
  assert.equal(
    fs.readdirSync(path.join(process.env.DATA_DIR, "backups")).length,
    1,
  );
  console.log("PASS 3. restart does not duplicate versions or backups");
  assert.throws(() =>
    db.prepare("UPDATE style_versions SET dna_json=?").run("{}"),
  );
  console.log("PASS 4. database enforces immutable snapshots");
  assert.equal(
    fs.readFileSync(path.join(completeBackup, file), "utf8"),
    "unchanged historical original",
  );
  const complete = new Database(
    path.join(completeBackup, "fashion-studio.db"),
    { readonly: true },
  );
  assert.equal(
    complete.prepare("SELECT COUNT(*) AS n FROM style_dna_templates").get().n,
    1,
  );
  complete.close();
  console.log(
    "PASS 5. complete upgrade backup preserves database and original uploads",
  );
  console.log("Style migration: 5/5 passed");
} finally {
  closeDb();
  fs.rmSync(completeBackup, { recursive: true, force: true });
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
