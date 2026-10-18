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
  const app = createApp();
  app.listen(cfg.port, () => {
    console.log(`Fashion Studio server listening on :${cfg.port}`);
  });
}
