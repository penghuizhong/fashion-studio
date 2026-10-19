import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getConfig } from './config.js';
import { getDb } from './db.js';

// Derivatives are disposable. Original bytes and database references never change.
export function previewFile(file) {
  return path.join(getConfig().dataDir || './data', 'uploads/studio/previews', `${crypto.createHash('sha256').update(file).digest('hex')}.webp`);
}
export function ownedStudioFile(file, uid) {
  if (!/^uploads\/studio\/(?!.*(?:^|\/)\.\.)[^?\0\\]+$/.test(file)) return false;
  if (!getConfig().multiUser) return true;
  return !!getDb().prepare(`SELECT 1 FROM dna_generations WHERE user_id=? AND lifecycle!='deleted' AND (image_path=? OR thumb_path=?)
    UNION ALL SELECT 1 FROM style_dna_templates WHERE user_id=? AND lifecycle!='deleted' AND (source_image_path=? OR source_thumb_path=?)
    UNION ALL SELECT 1 FROM exploration_batches b,json_each(b.renders_json) r WHERE b.user_id=? AND (json_extract(r.value,'$.image_path')=? OR json_extract(r.value,'$.thumb_path')=?)
    UNION ALL SELECT 1 FROM style_references WHERE user_id=? AND (image_path=? OR thumb_path=?)
    UNION ALL SELECT 1 FROM explore_items i JOIN explore_jobs j ON j.id=i.job_id WHERE j.user_id=? AND (json_extract(i.result_json,'$.image_path')=? OR json_extract(i.result_json,'$.thumb_path')=?) LIMIT 1`)
    .get(uid,file,file,uid,file,file,uid,file,file,uid,file,file,uid,file,file);
}
export async function writeStudioPreview(bytes, file) {
  const dest = previewFile(file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${crypto.randomUUID()}.tmp`;
  try {
    await sharp(bytes, { limitInputPixels: 40000000 }).rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toFile(temp);
    fs.renameSync(temp, dest);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return dest;
}
const pending = new Set(), queue = [];
let working = false;
function enqueue(file, absolute) {
  if (pending.has(file) || queue.length >= 100) return;
  pending.add(file); queue.push({ file, absolute });
  if (working) return;
  working = true;
  setImmediate(async () => {
    try {
      while (queue.length) {
        const item = queue.shift();
        try { await writeStudioPreview(item.absolute, item.file); }
        catch { /* Missing/invalid legacy original: keep explicit thumbnail fallback. */ }
        finally { pending.delete(item.file); }
      }
    } finally { working = false; }
  });
}
export function mountStudioPreview(app) {
  app.get('/api/studio/preview', (req, res) => {
    const uid = req.userId || 'local', file = String(req.query.path || '');
    res.set('Cache-Control', 'private, no-cache');
    res.vary('Cookie');
    if (getConfig().multiUser && !req.userId) return res.status(401).end();
    if (req.query.viewer && req.query.viewer !== String(uid)) return res.status(404).end();
    if (!ownedStudioFile(file, uid)) return res.status(404).end();
    const root = path.resolve(getConfig().dataDir || './data', 'uploads/studio');
    const original = path.resolve(getConfig().dataDir || './data', file);
    if (!original.startsWith(root + path.sep) || /\/(?:thumbs|previews)\//.test(file)) return res.status(404).end();
    let source;
    try { source = fs.statSync(original); if (!source.isFile()) return res.status(404).end(); }
    catch { return res.status(404).end(); }
    const preview = previewFile(file);
    try {
      if (fs.statSync(preview).mtimeMs >= source.mtimeMs) return res.sendFile(path.resolve(preview));
    } catch {}
    enqueue(file, original);
    // Do not make the first open wait for compression of an old 4K file.
    res.set('Retry-After', '1').status(202).json({ pending: true });
  });
}
