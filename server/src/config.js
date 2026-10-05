// 集中读取环境变量（懒加载，避免 import 时机问题）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion = null;
export function getVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')
    );
    cachedVersion = pkg.version || '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export function getConfig() {
  const env = process.env;
  return {
    apiKey: env.OPENROUTER_API_KEY || '',
    baseUrl: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    chatModel: env.CHAT_MODEL || 'deepseek/deepseek-chat',
    extractModel: env.EXTRACT_MODEL || 'deepseek/deepseek-chat',
    contextBudget: parseInt(env.CONTEXT_BUDGET || '8000', 10),
    extractEveryN: parseInt(env.EXTRACT_EVERY_N || '5', 10),
    port: parseInt(env.PORT || '3001', 10),
    mockLlm: env.MOCK_LLM === 'true',
    dataDir: env.DATA_DIR || './data',
    // ---- 多用户模式 ----
    multiUser: env.MULTI_USER === 'true',
    masterKey: env.MASTER_KEY || '',
    sessionSecret: env.SESSION_SECRET || '',
  };
}

// 多用户模式启动校验：MASTER_KEY 缺失或非法 → 抛错，调用方负责报错退出
// （SESSION_SECRET 已废弃：会话是 DB 里的随机 token，不再需要它；.env 里留着也无妨）
export function assertMultiUserConfig(cfg) {
  if (!cfg.multiUser) return;
  if (!/^[0-9a-fA-F]{64}$/.test(cfg.masterKey || '')) {
    throw new Error('[config] 多用户模式要求 MASTER_KEY 为 64 位 hex 字符（32 字节），请检查环境变量');
  }
}
