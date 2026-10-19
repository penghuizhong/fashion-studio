import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';

// Image files are shared by adopted cards, forks, references and job history.
// An archive removes a record from active lists, never the shared bytes.
export function sharedImageFile(db, generation) {
  const files = [...new Set([generation.image_path, generation.thumb_path].filter(Boolean))];
  return files.some(file => db.prepare(`
    SELECT 1 FROM style_dna_templates WHERE source_image_path=? OR source_thumb_path=?
    UNION ALL SELECT 1 FROM dna_generations WHERE id!=? AND (image_path=? OR thumb_path=?)
    UNION ALL SELECT 1 FROM style_references WHERE image_path=? OR thumb_path=?
    UNION ALL SELECT 1 FROM exploration_batches,json_tree(renders_json) j WHERE j.type='text' AND j.value=?
    UNION ALL SELECT 1 FROM explore_items,json_tree(result_json) j WHERE j.type='text' AND j.value=?
    UNION ALL SELECT 1 FROM explore_jobs,json_tree(snapshot_json) j WHERE j.type='text' AND j.value=?
    UNION ALL SELECT 1 FROM explore_quotes,json_tree(payload_json) j WHERE j.type='text' AND j.value=?
    LIMIT 1
  `).get(file, file, generation.id, file, file, file, file, file, file, file, file));
}

export function studioFileExists(file) {
  if (!file || typeof file !== 'string') return false;
  const root = path.resolve(getConfig().dataDir || './data', 'uploads/studio');
  const absolute = path.resolve(getConfig().dataDir || './data', file);
  if (!absolute.startsWith(root + path.sep)) return false;
  try { return fs.statSync(absolute).isFile(); } catch { return false; }
}
export function imageAvailability(row) {
  return { ...row, image_available: studioFileExists(row.image_path), thumb_available: studioFileExists(row.thumb_path) };
}
