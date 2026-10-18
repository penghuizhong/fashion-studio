import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 极简 .env 解析（不引入 dotenv 包）：server/.env
try {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) {
        const k = t.slice(0, i).trim();
        if (k && !(k in process.env)) process.env[k] = t.slice(i + 1).trim();
      }
    }
  }
} catch {
  /* 忽略 .env 读取失败 */
}

import { createApp } from './app.js';
import { getDb } from './db.js';
import { getConfig, assertMultiUserConfig } from './config.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = getConfig();
  try {
    assertMultiUserConfig(cfg); // 多用户模式：MASTER_KEY/SESSION_SECRET 缺失或非法 → 报错退出
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (cfg.multiUser) console.log('[auth] 多用户模式已启用');
  getDb(); // 初始化数据库
  // P7: 存量模板来源图缩略图回填（异步，不阻塞启动；新模板在创建时已存）
  (async () => {
    try {
      const db = getDb();
      const rows = db.prepare("SELECT id, source_image_path FROM style_dna_templates WHERE source_image_path != '' AND (source_thumb_path IS NULL OR source_thumb_path = '')").all();
      if (!rows.length) return;
      const sharp = (await import('sharp')).default;
      const dataDir = getConfig().dataDir || './data';
      const upd = db.prepare('UPDATE style_dna_templates SET source_thumb_path=? WHERE id=?');
      let done = 0;
      for (const r of rows) {
        try {
          const abs = path.join(dataDir, r.source_image_path);
          if (!fs.existsSync(abs)) continue;
          const dir = path.join(dataDir, 'uploads', 'studio', 'thumbs');
          fs.mkdirSync(dir, { recursive: true });
          const filename = path.basename(r.source_image_path);
          await sharp(abs).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(path.join(dir, filename));
          upd.run(path.posix.join('uploads', 'studio', 'thumbs', filename), r.id);
          done++;
        } catch { /* 单张失败跳过 */ }
      }
      if (done) console.log(`[p7] 回填来源图缩略图：${done} 个模板`);
    } catch (e) { console.warn('[p7] 缩略图回填失败:', e.message); }
  })();
  const app = createApp();
  app.listen(cfg.port, () => {
    console.log(`Fashion Studio server listening on :${cfg.port}`);
  });
}
