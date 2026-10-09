// SoulChat 后端回归测试（MOCK_LLM=true，临时 DATA_DIR）
// 用法：
//   node scripts/check.js                  # 单用户模式：20 项（不设 MULTI_USER）
//   CHECK_MODE=multi node scripts/check.js  # 多用户模式套件（13 项）
// 多用户模式所需环境变量：MULTI_USER=true（脚本自动设置）、MASTER_KEY（64 位 hex，未提供则自动生成）、
// SESSION_SECRET（未提供则用 testsecret）。两套件各用独立临时 DATA_DIR，跑完可删。
// 注意：只扩展本文件；不要改版本号，不要碰 client/ 与 soulchat-preview。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MODE = process.env.CHECK_MODE === 'multi' ? 'multi' : 'single';

process.env.MOCK_LLM = 'true';
process.env.AUTH_LIMIT_MAX = '100'; // 回归测试内多次注册/登录，不触发限流
process.env.WRITE_LIMIT_MAX = '1000'; // 回归测试内写请求多，不触发写限流
if (MODE === 'multi') {
  process.env.MULTI_USER = 'true';
  if (!process.env.MASTER_KEY) process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'testsecret';
}
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), MODE === 'multi' ? 'soulchat-check-multi-' : 'soulchat-check-')
);
const { createApp } = await import('../src/app.js');
const { estimateTokens, summarizeOld, runMemoryPipeline, retrieveFacts } = await import('../src/memory.js');
const { getDb } = await import('../src/db.js');
const { llmCreds, encryptSecret, decryptSecret } = await import('../src/auth.js');
const { getConfig } = await import('../src/config.js');

const results = [];
function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail: cond ? '' : String(detail) });
}

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- 简易 cookie jar（多用户套件：每个用户一个 jar） ----------
function makeJar() {
  const cookies = {};
  return {
    capture(res) {
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const sc of list) {
        const pair = String(sc).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
    },
    header() {
      const parts = Object.entries(cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
      return parts.length ? parts.join('; ') : '';
    },
  };
}

async function req(method, p, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.jar) {
    const c = opts.jar.header();
    if (c) headers.Cookie = c;
  }
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (opts.jar) opts.jar.capture(res);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json, setCookies };
}

function parseSSE(text) {
  const events = [];
  for (const chunk of String(text).split('\n\n')) {
    let event = null;
    let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event) {
      let parsed = data;
      try {
        parsed = JSON.parse(data);
      } catch {}
      events.push({ event, data: parsed });
    }
  }
  return events;
}

async function postSSE(p, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.jar) {
    const c = opts.jar.header();
    if (c) headers.Cookie = c;
  }
  const res = await fetch(base + p, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (opts.jar) opts.jar.capture(res);
  const text = await res.text();
  return { status: res.status, events: parseSSE(text) };
}

// ================= 单用户套件（20 项，原样保留） =================

// 共享给 check-single.js / check-multi.js
export { ok, results, req, postSSE, makeJar, parseSSE, base, app, server, MODE };
export { getDb, getConfig, estimateTokens, summarizeOld, runMemoryPipeline, retrieveFacts };
export { llmCreds, encryptSecret, decryptSecret };
