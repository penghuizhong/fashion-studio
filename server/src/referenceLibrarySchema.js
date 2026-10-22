// Additive metadata migration; original file paths and owner bindings are unchanged.
export function migrateReferenceLibrary(db) {
  const referenceColumns = db.prepare('PRAGMA table_info(style_references)').all().map(c => c.name);
  if (!referenceColumns.includes('name')) db.exec("ALTER TABLE style_references ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  if (!referenceColumns.includes('kind')) {
    db.transaction(() => {
      db.exec("ALTER TABLE style_references ADD COLUMN kind TEXT NOT NULL DEFAULT 'reference'");
      // Existing model attachments are already durable files; classify them once.
      db.exec(`UPDATE style_references SET kind='model' WHERE EXISTS (
        SELECT 1 FROM style_plans p, json_each(CASE WHEN json_valid(p.input_json) THEN p.input_json ELSE '{}' END,'$.references') r
        WHERE p.user_id=style_references.user_id AND json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.role')='model'
        AND json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.source')='ref:'||style_references.id)`);
    })();
  }
  db.exec('CREATE INDEX IF NOT EXISTS style_reference_library ON style_references(user_id,kind,id)');
}
