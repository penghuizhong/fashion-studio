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
if (MODE === 'multi') {
  process.env.MULTI_USER = 'true';
  if (!process.env.MASTER_KEY) process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'testsecret';
}
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), MODE === 'multi' ? 'soulchat-check-multi-' : 'soulchat-check-')
);

const { createApp } = await import('../src/app.js');
const { estimateTokens, summarizeOld } = await import('../src/memory.js');
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
async function runSingle() {
  let charId = null;
  let convId = null;

  // 1. GET /api/config
  {
    const r = await req('GET', '/api/config');
    ok(
      '1. GET /api/config：has_key=false 且模型名非空',
      r.status === 200 && r.json.has_key === false && typeof r.json.chat_model === 'string' && r.json.chat_model.length > 0,
      JSON.stringify(r.json)
    );
  }

  // 2. POST /api/characters
  {
    const r = await req('POST', '/api/characters', { name: '小灵' });
    charId = r.json && r.json.id;
    ok(
      '2. POST /api/characters：soul_md 包含 # 身份',
      r.status === 201 && charId && typeof r.json.soul_md === 'string' && r.json.soul_md.includes('# 身份'),
      JSON.stringify(r.json).slice(0, 300)
    );
  }

  // 3. GET /api/characters
  {
    const r = await req('GET', '/api/characters');
    ok(
      '3. GET /api/characters：长度 1 且 conversation_count 为数字（新角色为 0）',
      r.status === 200 && Array.isArray(r.json) && r.json.length === 1 && r.json[0].conversation_count === 0,
      JSON.stringify(r.json).slice(0, 300)
    );
  }

  // 4. PUT /api/characters/:id 改名
  {
    const r = await req('PUT', `/api/characters/${charId}`, { name: '小灵改' });
    ok('4. PUT /api/characters/:id 改名成功', r.status === 200 && r.json.name === '小灵改', JSON.stringify(r.json));
  }

  // 5. GET files
  {
    const r = await req('GET', `/api/characters/${charId}/files`);
    ok(
      '5. GET files：三字段齐全',
      r.status === 200 && typeof r.json.soul_md === 'string' && typeof r.json.user_md === 'string' && typeof r.json.memory_md === 'string',
      JSON.stringify(r.json).slice(0, 200)
    );
  }

  // 6. PUT files 只改 user_md
  {
    const r = await req('PUT', `/api/characters/${charId}/files`, { user_md: '- 称呼：阿钟' });
    const changedOk =
      r.status === 200 && Array.isArray(r.json.changed) && r.json.changed.length === 1 && r.json.changed[0] === 'user';
    const v = await req('GET', `/api/characters/${charId}/file-versions?file=user&limit=20`);
    ok(
      '6. PUT files 只改 user_md：changed=["user"] 且版本记录 1 条',
      changedOk && v.status === 200 && Array.isArray(v.json) && v.json.length === 1,
      `changed=${JSON.stringify(r.json && r.json.changed)} versions=${JSON.stringify(v.json)}`
    );
  }

  // 6b. 版本回滚：先改一次，再回滚到最初版本
  {
    const v0 = await req('GET', `/api/characters/${charId}/file-versions?file=user&limit=20`);
    const firstId = v0.json && v0.json[0] && v0.json[0].id;
    const firstContent = v0.json && v0.json[0] && v0.json[0].content;
    await req('PUT', `/api/characters/${charId}/files`, { user_md: '- 称呼：改成别人' });
    const rb = await req('POST', `/api/characters/${charId}/file-versions/${firstId}/rollback`);
    const f = await req('GET', `/api/characters/${charId}/files`);
    const v1 = await req('GET', `/api/characters/${charId}/file-versions?file=user&limit=20`);
    ok(
      '6b. 版本回滚：内容恢复且版本数+1',
      rb.status === 200 && rb.json.ok === true &&
        f.status === 200 && f.json.user_md === firstContent &&
        Array.isArray(v1.json) && v1.json.length === 3,
      `rollback=${rb.status} user_md=${JSON.stringify(f.json && f.json.user_md)} versions=${v1.json && v1.json.length}`
    );
  }
  {
    const c = await req('POST', `/api/characters/${charId}/conversations`, {});
    convId = c.json && c.json.id;
    const l = await req('GET', `/api/characters/${charId}/conversations`);
    ok(
      '7. 新建对话 + 列表有 1 条且 message_count=0',
      c.status === 201 && convId && l.status === 200 && l.json.length === 1 && l.json[0].message_count === 0,
      JSON.stringify(l.json).slice(0, 300)
    );
  }

  // 8. POST messages "你好"：context/token/done
  {
    const { status, events } = await postSSE(`/api/conversations/${convId}/messages`, { content: '你好' });
    const ctx = events.find((e) => e.event === 'context');
    const toks = events.filter((e) => e.event === 'token');
    const done = events.find((e) => e.event === 'done');
    ok(
      '8. POST messages：context(used≤budget)+token+done 事件',
      status === 200 &&
        ctx && typeof ctx.data.used === 'number' && ctx.data.used <= ctx.data.budget &&
        toks.length > 0 &&
        done && typeof done.data.message_id === 'number',
      `status=${status} events=${events.map((e) => e.event).join(',')}`
    );
  }

  // 9. GET messages：2 条，user→assistant
  {
    const r = await req('GET', `/api/conversations/${convId}/messages?limit=200`);
    ok(
      '9. GET messages：2 条，角色顺序 user→assistant',
      r.status === 200 && r.json.length === 2 && r.json[0].role === 'user' && r.json[1].role === 'assistant',
      JSON.stringify(r.json.map((m) => m.role))
    );
  }

  // 10. 再发 4 轮（凑满 5 条 assistant）：第 5 轮 SSE 含 memory_updated
  {
    const texts = ['今天天气真不错', '你喜欢什么颜色', '讲个简短的笑话', '好的再见'];
    let fifthEvents = null;
    for (let i = 0; i < texts.length; i++) {
      const { events } = await postSSE(`/api/conversations/${convId}/messages`, { content: texts[i] });
      if (i === texts.length - 1) fifthEvents = events;
    }
    const memEv = fifthEvents.find((e) => e.event === 'memory_updated');
    const f = await req('GET', `/api/characters/${charId}/files`);
    ok(
      '10. 第 5 轮 SSE 含 memory_updated；memory_md 含 "mock 提取"',
      !!memEv && Array.isArray(memEv.data.files) && memEv.data.files.includes('memory') &&
        f.status === 200 && typeof f.json.memory_md === 'string' && f.json.memory_md.includes('mock 提取'),
      `events=${fifthEvents.map((e) => e.event).join(',')} memory_md=${JSON.stringify(f.json && f.json.memory_md).slice(0, 120)}`
    );
  }

  // 11. estimateTokens 单测
  {
    const a = estimateTokens('hello');
    const b = estimateTokens('你好世界');
    ok(
      '11. estimateTokens("hello")≈2±1，"你好世界"≈3±1',
      Math.abs(a - 2) <= 1 && Math.abs(b - 3) <= 1,
      `hello→${a} 你好世界→${b}`
    );
  }

  // 12. summarizeOld 单测：45 条消息 → 生成 1 条摘要
  {
    const db = getDb();
    const t = new Date().toISOString();
    const conv2 = 'conv-test-12';
    db.prepare('INSERT INTO conversations(id, character_id, title, created_at, updated_at) VALUES(?,?,?,?,?)').run(
      conv2, charId, '摘要测试', t, t
    );
    const ins = db.prepare('INSERT INTO messages(conversation_id, role, content, tokens, created_at) VALUES(?,?,?,?,?)');
    for (let i = 0; i < 45; i++) {
      ins.run(conv2, i % 2 === 0 ? 'user' : 'assistant', `测试消息第${i + 1}条`, 5, t);
    }
    const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
    const made = await summarizeOld(char, conv2);
    const rows = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').all(conv2);
    ok(
      '12. summarizeOld：45 条消息 → 新增 1 条摘要且 message_upto>0',
      made === true && rows.length === 1 && rows[0].message_upto > 0 && typeof rows[0].summary === 'string' && rows[0].summary.length > 0,
      `made=${made} rows=${rows.length} upto=${rows[0] && rows[0].message_upto}`
    );
  }

  // 13. 改标题 → 删对话 → 删角色
  {
    const u = await req('PUT', `/api/conversations/${convId}`, { title: '改名测试' });
    const d1 = await req('DELETE', `/api/conversations/${convId}`);
    const m = await req('GET', `/api/conversations/${convId}/messages`);
    const d2 = await req('DELETE', `/api/characters/${charId}`);
    const l = await req('GET', '/api/characters');
    ok(
      '13. 改标题→删对话(messages 为空)→删角色(列表为空)',
      u.status === 200 && u.json.title === '改名测试' &&
        d1.status === 200 && m.status === 404 &&
        d2.status === 200 && l.status === 200 && Array.isArray(l.json) && l.json.length === 0,
      `title=${u.json && u.json.title} delConv=${d1.status} msgs=${m.status} delChar=${d2.status} chars=${JSON.stringify(l.json)}`
    );
  }

  // 15. 模型列表（mock 模式返回假数据）
  {
    const { status, json } = await req('GET', '/api/models');
    ok(
      '15. GET /api/models（mock）→ 返回模型数组',
      status === 200 && json && Array.isArray(json.models) && json.models.length > 0 && json.models[0].id,
      `status=${status} models=${JSON.stringify(json && json.models)}`
    );
  }

  // 17. 群聊：建群校验 + 建群 + 列表 + 详情
  let groupId = null;
  {
    const bad = await req('POST', '/api/groups', { member_ids: ['x'] });
    const c1 = await req('POST', '/api/characters', { name: '群A', avatar: '🅰️' });
    const c2 = await req('POST', '/api/characters', { name: '群B', avatar: '🅱️' });
    const c3 = await req('POST', '/api/characters', { name: '群C', avatar: '🅲' });
    const g = await req('POST', '/api/groups', { name: '测试群', member_ids: [c1.json.id, c2.json.id, c3.json.id] });
    groupId = g.json && g.json.id;
    const list = await req('GET', '/api/groups');
    const detail = groupId ? await req('GET', `/api/groups/${groupId}`) : { json: null };
    ok(
      '17. 建群(1人400)→建群201→列表1个→详情3成员',
      bad.status === 400 && g.status === 201 && Array.isArray(list.json) && list.json.length === 1 &&
        detail.json && detail.json.members && detail.json.members.length === 3,
      `bad=${bad.status} g=${g.status} list=${JSON.stringify(list.json)} members=${detail.json && detail.json.members && detail.json.members.length}`
    );
    // 清理：删群 + 删角色
    await req('DELETE', `/api/conversations/${groupId}`);
    for (const c of [c1, c2, c3]) await req('DELETE', `/api/characters/${c.json.id}`);
  }

  // 18. 群聊 SSE：@点名只让被点名的回，事件带 turn_start/turn_done
  {
    const c1 = await req('POST', '/api/characters', { name: '点名A', avatar: '🅰️' });
    const c2 = await req('POST', '/api/characters', { name: '点名B', avatar: '🅱️' });
    const g = await req('POST', '/api/groups', { member_ids: [c1.json.id, c2.json.id] });
    const gid = g.json.id;
    const { status, events } = await postSSE(`/api/conversations/${gid}/messages`, { content: '大家好@点名B' });
    const starts = events.filter((e) => e.event === 'turn_start').map((e) => e.data && e.data.character_name);
    const dones = events.filter((e) => e.event === 'turn_done').length;
    const hasDone = events.some((e) => e.event === 'done');
    const msgs = await req('GET', `/api/conversations/${gid}/messages`);
    const asst = msgs.json.filter((m) => m.role === 'assistant');
    ok(
      '18. 群聊@点名 → 只有被点名的发言（turn_start/turn_done/done 事件齐全）',
      status === 200 && starts.length === 1 && starts[0] === '点名B' && dones === 1 && hasDone &&
        asst.length === 1 && asst[0].character_name === '点名B',
      `status=${status} starts=${JSON.stringify(starts)} dones=${dones} asst=${asst.length}`
    );
    // 19. 不@时导演决策（mock 取前 2 个）
    const r2 = await postSSE(`/api/conversations/${gid}/messages`, { content: '随便聊聊' });
    const starts2 = r2.events.filter((e) => e.event === 'turn_start').length;
    ok('19. 群聊无@时导演决策 → mock 下 2 个角色依次发言', starts2 === 2, `turn_start=${starts2}`);
    // 20. 更新成员 + 删除群聊级联
    const c3 = await req('POST', '/api/characters', { name: '点名C', avatar: '🅲' });
    const um = await req('PUT', `/api/groups/${gid}/members`, { member_ids: [c1.json.id, c3.json.id] });
    const del = await req('DELETE', `/api/conversations/${gid}`);
    const listAfter = await req('GET', '/api/groups');
    ok(
      '20. 更新成员→删除群聊→列表为空',
      um.status === 200 && um.json.members.length === 2 && del.status === 200 &&
        Array.isArray(listAfter.json) && listAfter.json.length === 0,
      `um=${um.status} members=${um.json && um.json.members && um.json.members.length} del=${del.status}`
    );
    for (const c of [c1, c2, c3]) await req('DELETE', `/api/characters/${c.json.id}`);
  }

  // 21. 不存在的对话发消息
  {
    const { status, events } = await postSSE('/api/conversations/does-not-exist/messages', { content: '嗨' });
    const hasError = events.some((e) => e.event === 'error');
    ok('21. 不存在的对话发消息 → error 事件或 HTTP 404', status === 404 || hasError, `status=${status} events=${events.map((e) => e.event).join(',')}`);
  }
}

// ================= 多用户套件（13 项） =================
async function runMulti() {
  const jarA = makeJar(); // 用户 A
  const jarB = makeJar(); // 用户 B
  const anon = makeJar(); // 未登录
  let userA = null;
  let charA = null;
  let convA = null;
  let charB = null;

  // M1. 注册 A → 201 且自动登录（set-cookie 有 HttpOnly 会话 cookie）
  {
    const r = await req('POST', '/api/auth/register', { username: 'testuserA', password: 'password123' }, { jar: jarA });
    userA = r.json && r.json.user;
    const sc = (r.setCookies || []).join('; ');
    ok(
      'M1. 注册 A → 201 自动登录（set-cookie 有 HttpOnly 会话 cookie）',
      r.status === 201 && userA && userA.username === 'testuserA' && typeof userA.id === 'string' &&
        /soulchat_session=[^;\s]+/.test(sc) && /httponly/i.test(sc),
      `status=${r.status} body=${JSON.stringify(r.json)} set-cookie=${sc.slice(0, 140)}`
    );
  }

  // M2. 注册校验
  {
    const badShort = await req('POST', '/api/auth/register', { username: 'ab', password: 'password123' });
    const badChars = await req('POST', '/api/auth/register', { username: 'bad name!', password: 'password123' });
    const shortPw = await req('POST', '/api/auth/register', { username: 'testuserC', password: '1234567' });
    const dup = await req('POST', '/api/auth/register', { username: 'testuserA', password: 'password123' });
    ok(
      'M2. 注册校验：非法用户名 400×2、短密码 400、重名 409',
      badShort.status === 400 && badChars.status === 400 && shortPw.status === 400 && dup.status === 409,
      `short=${badShort.status} chars=${badChars.status} shortPw=${shortPw.status} dup=${dup.status}(${JSON.stringify(dup.json)})`
    );
  }

  // M3. GET /api/auth/me
  {
    const r = await req('GET', '/api/auth/me', undefined, { jar: jarA });
    ok(
      'M3. GET /api/auth/me → 200 返回 {user:{username}}',
      r.status === 200 && r.json && r.json.user && r.json.user.username === 'testuserA' && r.json.user.id === userA.id,
      JSON.stringify(r.json)
    );
  }

  // M4. 限流（放最前：同一进程内 modelsLimiter 按 IP 累计，此前未调过 /api/models）
  {
    let firstBad = -1;
    let last = null;
    for (let i = 0; i < 11; i++) {
      const r = await req('GET', '/api/models', undefined, { jar: jarA });
      if (r.status !== 200 && firstBad < 0) firstBad = i;
      last = r;
    }
    ok(
      'M4. 限流：GET /api/models 前 10 次 200，第 11 次 → 429',
      firstBad === 10 && last.status === 429 && /频繁/.test(String((last.json && last.json.error) || '')),
      `firstBadIndex=${firstBad} last=${last.status} err=${JSON.stringify(last.json)}`
    );
  }

  // M5. 未登录 401
  {
    const g = await req('GET', '/api/characters', undefined, { jar: anon });
    const p = await req('POST', '/api/characters/no-such-id/conversations', {}, { jar: anon });
    ok(
      'M5. 未登录：GET /api/characters → 401；POST 建对话 → 401',
      g.status === 401 && p.status === 401,
      `get=${g.status}(${JSON.stringify(g.json)}) post=${p.status}`
    );
  }

  // M6. A 建角色 + 建对话 + 发消息（mock SSE）
  {
    const c = await req('POST', '/api/characters', { name: '阿灵' }, { jar: jarA });
    charA = c.json && c.json.id;
    const cv = await req('POST', `/api/characters/${charA}/conversations`, {}, { jar: jarA });
    convA = cv.json && cv.json.id;
    const { status, events } = await postSSE(`/api/conversations/${convA}/messages`, { content: '你好' }, { jar: jarA });
    const ctx = events.find((e) => e.event === 'context');
    const toks = events.filter((e) => e.event === 'token');
    const done = events.find((e) => e.event === 'done');
    ok(
      'M6. A 建角色+建对话+发消息：SSE context/token/done 齐全',
      c.status === 201 && !!charA && cv.status === 201 && !!convA &&
        status === 200 && !!ctx && toks.length > 0 && done && typeof done.data.message_id === 'number',
      `c=${c.status} cv=${cv.status} sse=${status} events=${events.map((e) => e.event).join(',')}`
    );
  }

  // M7. 托管 Key：PUT → GET（hasKey 且无明文）→ DB 存密文 → AES 往返
  {
    const put = await req(
      'PUT', '/api/user/api-key',
      { key: 'sk-test-123', baseUrl: '', chatModel: '', workerModel: '' },
      { jar: jarA }
    );
    const get = await req('GET', '/api/user/api-key', undefined, { jar: jarA });
    const bodyStr = JSON.stringify(get.json);
    const row = getDb().prepare('SELECT enc_key FROM user_api_keys WHERE user_id = ?').get(userA.id);
    const cipherOk = !!(row && row.enc_key && !row.enc_key.includes('sk-test-123') && row.enc_key.split(':').length === 3);
    const roundtrip = decryptSecret(process.env.MASTER_KEY, encryptSecret(process.env.MASTER_KEY, 'sk-test-123')) === 'sk-test-123';
    ok(
      'M7. 托管 Key：PUT 200 hasKey；GET hasKey:true 且无明文；DB 存密文；AES-256-GCM 往返正常',
      put.status === 200 && put.json && put.json.ok === true && put.json.hasKey === true &&
        get.status === 200 && get.json && get.json.hasKey === true &&
        get.json.baseUrl === '' && get.json.chatModel === '' && get.json.workerModel === '' &&
        !bodyStr.includes('sk-test-123') && cipherOk && roundtrip,
      `put=${put.status}(${JSON.stringify(put.json)}) get=${bodyStr} cipherOk=${cipherOk} roundtrip=${roundtrip}`
    );
  }

  // M7b. 托管 Key 合并语义：不传 key=保持原值；key:''=清除；其余字段独立更新
  {
    // 当前已存：key=sk-test-123（M7），其余为空
    const put1 = await req(
      'PUT', '/api/user/api-key',
      { chatModel: 'model-x' }, // 不带 key
      { jar: jarA }
    );
    const get1 = await req('GET', '/api/user/api-key', undefined, { jar: jarA });
    const put2 = await req(
      'PUT', '/api/user/api-key',
      { key: '', baseUrl: 'https://example.com/v1' }, // 清除 key，设置 baseUrl
      { jar: jarA }
    );
    const get2 = await req('GET', '/api/user/api-key', undefined, { jar: jarA });
    ok(
      'M7b. 合并语义：不传 key 时 key 保持；key:"" 清除 key 但保留 chatModel；baseUrl 独立更新',
      put1.status === 200 && put1.json && put1.json.hasKey === true &&
        get1.json && get1.json.hasKey === true && get1.json.chatModel === 'model-x' &&
        put2.status === 200 && put2.json && put2.json.hasKey === false &&
        get2.json && get2.json.hasKey === false && get2.json.chatModel === 'model-x' &&
        get2.json.baseUrl === 'https://example.com/v1',
      `put1.hasKey=${put1.json && put1.json.hasKey} get1=${JSON.stringify(get1.json)} put2.hasKey=${put2.json && put2.json.hasKey} get2=${JSON.stringify(get2.json)}`
    );
    // 恢复现场：把 key 写回去，供后续用例（M8 断言托管 key 生效）
    await req('PUT', '/api/user/api-key', { key: 'sk-test-123' }, { jar: jarA });
  }

  // M8. llmCreds 单测：多用户模式忽略 X-OpenRouter-Key 头，使用托管 key
  // （MOCK_LLM 下聊天不校验 key，故用单元断言证明"托管 key 生效"这条契约）
  {
    const cfg = getConfig();
    const fakeReq = {
      userId: userA.id,
      headers: { 'x-openrouter-key': 'sk-header-bogus', 'x-api-base-url': '', 'x-chat-model': '', 'x-worker-model': '' },
    };
    const creds = llmCreds(fakeReq, cfg, (rq) => String(rq.headers['x-openrouter-key'] || '').trim());
    ok(
      'M8. llmCreds：多用户模式忽略 X-OpenRouter-Key 头，使用用户托管 key',
      cfg.multiUser === true && creds.apiKey === 'sk-test-123',
      `multiUser=${cfg.multiUser} match=${creds.apiKey === 'sk-test-123'}`
    );
  }

  // M9. 不带 X-OpenRouter-Key 头聊天 → 成功（mock 下 key 检查被绕过，托管生效见 M8）
  {
    const { status, events } = await postSSE(`/api/conversations/${convA}/messages`, { content: '第二轮' }, { jar: jarA });
    const done = events.find((e) => e.event === 'done');
    ok(
      'M9. 不带 X-OpenRouter-Key 头聊天 → 200 且 done',
      status === 200 && !!done && typeof done.data.message_id === 'number',
      `status=${status} events=${events.map((e) => e.event).join(',')}`
    );
  }

  // M10. 注册 B；数据隔离
  {
    const rb = await req('POST', '/api/auth/register', { username: 'testuserB', password: 'password123' }, { jar: jarB });
    const rc = await req('POST', '/api/characters', { name: 'B的角色' }, { jar: jarB });
    charB = rc.json && rc.json.id;
    const listB = await req('GET', '/api/characters', undefined, { jar: jarB });
    const bSeeConvA = await req('GET', `/api/conversations/${convA}/messages`, undefined, { jar: jarB });
    const bSeeCharA = await req('GET', `/api/characters/${charA}`, undefined, { jar: jarB });
    const aSeeCharB = await req('GET', `/api/characters/${charB}`, undefined, { jar: jarA });
    ok(
      'M10. 数据隔离：B 列表只有自己的 1 个角色；B 看 A 的对话/角色 → 404；A 看 B 的角色 → 404',
      rb.status === 201 && rc.status === 201 && !!charB &&
        listB.status === 200 && Array.isArray(listB.json) && listB.json.length === 1 && listB.json[0].id === charB &&
        bSeeConvA.status === 404 && bSeeCharA.status === 404 && aSeeCharB.status === 404,
      `regB=${rb.status} listB=${listB.json && listB.json.length} bSeeConvA=${bSeeConvA.status} bSeeCharA=${bSeeCharA.status} aSeeCharB=${aSeeCharB.status}`
    );
  }

  // M11. 登录：错密码 401；正确密码 200 + set-cookie
  {
    const jarL = makeJar();
    const wrong = await req('POST', '/api/auth/login', { username: 'testuserA', password: 'wrongpass1' }, { jar: jarL });
    const right = await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarL });
    const sc = (right.setCookies || []).join('; ');
    const me = await req('GET', '/api/auth/me', undefined, { jar: jarL });
    ok(
      'M11. 登录：错密码 → 401；正确密码 → 200+set-cookie 且 me 正常',
      wrong.status === 401 && right.status === 200 && /soulchat_session=[^;\s]+/.test(sc) &&
        me.status === 200 && me.json.user.username === 'testuserA',
      `wrong=${wrong.status}(${JSON.stringify(wrong.json)}) right=${right.status}`
    );
  }

  // M12. 退出登录
  {
    const lo = await req('POST', '/api/auth/logout', {}, { jar: jarA });
    const me = await req('GET', '/api/auth/me', undefined, { jar: jarA });
    const chat = await postSSE(`/api/conversations/${convA}/messages`, { content: '退出后说话' }, { jar: jarA });
    ok(
      'M12. 退出：logout → 200；之后 me → 401；同一聊天请求 → 401',
      lo.status === 200 && lo.json && lo.json.ok === true && me.status === 401 && chat.status === 401,
      `logout=${lo.status} me=${me.status} chat=${chat.status}`
    );
  }

  // M13. config multi_user
  {
    const r = await req('GET', '/api/config'); // 未登录也可访问
    ok(
      'M13. GET /api/config → multi_user:true（多用户进程）',
      r.status === 200 && r.json && r.json.multi_user === true,
      JSON.stringify(r.json)
    );
  }
}

try {
  if (MODE === 'multi') await runMulti();
  else await runSingle();
} catch (e) {
  ok('未捕获异常', false, e && e.stack ? e.stack : String(e));
} finally {
  server.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`[${MODE}] 通过 ${passed}/${results.length}`);
for (const r of results.filter((r) => !r.pass)) {
  console.log(`[失败] ${r.name}${r.detail ? ' → ' + r.detail : ''}`);
}
process.exit(passed === results.length ? 0 : 1);
