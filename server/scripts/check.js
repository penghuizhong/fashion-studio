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

  // 10. 再发 4 轮（凑满 5 条 assistant）：第 5 轮 done 先回（记忆提取已改后台），稍后 memory_md 被后台更新
  {
    const texts = ['今天天气真不错', '你喜欢什么颜色', '讲个简短的笑话', '好的再见'];
    let fifthEvents = null;
    for (let i = 0; i < texts.length; i++) {
      const { events } = await postSSE(`/api/conversations/${convId}/messages`, { content: texts[i] });
      if (i === texts.length - 1) fifthEvents = events;
    }
    const hasDone = fifthEvents.some((e) => e.event === 'done');
    const noMemEv = !fifthEvents.some((e) => e.event === 'memory_updated');
    // 等后台任务（setImmediate + mock）完成
    await new Promise((r) => setTimeout(r, 800));
    const f = await req('GET', `/api/characters/${charId}/files`);
    ok(
      '10. 第 5 轮 done 先回（无 memory_updated 事件）；后台记忆提取后 memory_md 含 "mock 提取"',
      hasDone && noMemEv &&
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

  // 22. 预设角色卡列表：18 张 + 7 个分类
  {
    const r = await req('GET', '/api/character-cards/presets');
    const cats = r.json && r.json.categories;
    ok(
      '22. GET /api/character-cards/presets → 200，18 张卡，7 个分类',
      r.status === 200 && Array.isArray(r.json.cards) && r.json.cards.length === 18 &&
        cats && Object.keys(cats).length === 7 &&
        r.json.cards.every((c) => c.id && c.name && c.greeting && c.soul_md && cats[c.category]),
      `status=${r.status} n=${r.json && r.json.cards && r.json.cards.length}`
    );
  }

  // 23. 一键领养：建角色 + 建对话 + 开场白首条消息
  {
    const r = await req('POST', '/api/character-cards/adopt', { preset_id: 'luchen' });
    const ch = r.json && r.json.character;
    const conv = r.json && r.json.conversation;
    const msgs = conv ? await req('GET', `/api/conversations/${conv.id}/messages`) : null;
    const first = msgs && msgs.json && msgs.json[0];
    ok(
      '23. POST adopt 预设卡 → 201：角色/对话/开场白消息齐全',
      r.status === 201 && ch && ch.name === '陆沉' && conv && conv.id &&
        Array.isArray(msgs.json) && msgs.json.length === 1 &&
        first.role === 'assistant' && first.content.length > 60,
      `status=${r.status} name=${ch && ch.name} msgs=${msgs && msgs.json && msgs.json.length}`
    );
    // 24. 非法 preset_id → 404；空 body → 400
    const bad = await req('POST', '/api/character-cards/adopt', { preset_id: 'no-such-card' });
    const empty = await req('POST', '/api/character-cards/adopt', {});
    ok(
      '24. adopt 非法 preset_id → 404；空 body → 400',
      bad.status === 404 && empty.status === 400,
      `bad=${bad.status} empty=${empty.status}`
    );
    if (ch) await req('DELETE', `/api/characters/${ch.id}`);
  }

  // 25. AI 生成角色卡（mock）：结构完整
  {
    const r = await req('POST', '/api/character-cards/generate', { prompt: '一只会讲冷笑话的猫耳女仆' });
    const card = r.json && r.json.card;
    ok(
      '25. POST generate（mock）→ 200：卡结构完整（名字/开场白/人设/示例对话）',
      r.status === 200 && card && card.name && card.greeting && card.soul_md &&
        Array.isArray(card.example_dialogues) && card.example_dialogues.length >= 1,
      `status=${r.status} name=${card && card.name}`
    );
    const empty = await req('POST', '/api/character-cards/generate', { prompt: '' });
    ok('25b. generate 空 prompt → 400', empty.status === 400, `status=${empty.status}`);
  }

  // 26. 广场发布（单用户模式直接上架）：建角色 → 发布 → my-published；空卖点/敏感词 → 400
  let sharedId = null;
  {
    const c = await req('POST', '/api/characters', { name: '投稿测试角' });
    const charId = c.json.id;
    const pub = await req('POST', '/api/character-cards/publish', {
      character_id: charId,
      tagline: '一只爱讲冷笑话的测试角色',
      description: '这是一张回归测试用的投稿卡片，简介六十字以上凑字数凑字数凑字数凑字数。',
      greeting: '（测试开场白）你好，我是投稿测试角，很高兴认识你！',
      category: 'comedy',
      tags: ['测试'],
    });
    sharedId = pub.json && pub.json.id;
    const my = await req('GET', '/api/character-cards/my-published');
    const bad1 = await req('POST', '/api/character-cards/publish', { character_id: charId, tagline: '', description: '简介' });
    const bad2 = await req('POST', '/api/character-cards/publish', { character_id: charId, tagline: '约炮神器', description: '简介六十字以上凑字数凑字数凑字数凑字数凑字数。', greeting: '开场白凑字数凑字数凑字数凑字数凑字数凑字数凑字数。' });
    const bad3 = await req('POST', '/api/character-cards/publish', { character_id: 'nope', tagline: 'x', description: '简介六十字以上凑字数凑字数凑字数凑字数凑字数。' });
    ok(
      '26. publish → 201 且单用户直接上架；my-published 有 1 条；空卖点/敏感词/不存在的角色 → 400/400/404',
      pub.status === 201 && pub.json.status === 'approved' && sharedId &&
        Array.isArray(my.json) && my.json.length === 1 && my.json[0].status === 'approved' &&
        bad1.status === 400 && bad2.status === 400 && bad3.status === 404,
      `pub=${pub.status}(${pub.json && pub.json.status}) my=${my.json && my.json.length} bad=${bad1.status},${bad2.status},${bad3.status}`
    );
  }

  // 27. 广场互动：列表可见 → 领养（adopt_count+1）→ 点赞/取消 → 举报 5 次自动下架
  {
    const list0 = await req('GET', '/api/character-cards/shared');
    const ad = await req('POST', `/api/character-cards/shared/${sharedId}/adopt`);
    const like1 = await req('POST', `/api/character-cards/shared/${sharedId}/like`);
    const like2 = await req('POST', `/api/character-cards/shared/${sharedId}/like`);
    for (let i = 0; i < 5; i++) await req('POST', `/api/character-cards/shared/${sharedId}/report`, { reason: '测试举报' });
    const list1 = await req('GET', '/api/character-cards/shared');
    const adChar = ad.json && ad.json.character;
    ok(
      '27. shared 列表可见 → 领养 201（角色已建）→ 点赞开/关 → 举报 5 次后列表消失（回 pending）',
      Array.isArray(list0.json) && list0.json.length === 1 && list0.json[0].adopt_count === 0 &&
        ad.status === 201 && adChar && adChar.name === '投稿测试角' &&
        like1.json.liked === true && like1.json.like_count === 1 &&
        like2.json.liked === false && like2.json.like_count === 0 &&
        Array.isArray(list1.json) && list1.json.length === 0,
      `list0=${list0.json && list0.json.length} ad=${ad.status} like=${like1.json.liked}/${like2.json.liked} list1=${list1.json && list1.json.length}`
    );
    if (adChar) await req('DELETE', `/api/characters/${adChar.id}`);
  }

  // 28. 图鉴：领养 2 张预设 → adopted_count 2；单用户无账本不报错
  {
    const a1 = await req('POST', '/api/character-cards/adopt', { preset_id: 'luchen' });
    const a2 = await req('POST', '/api/character-cards/adopt', { preset_id: 'taoyao' });
    const col = await req('GET', '/api/character-cards/collection');
    ok(
      '28. 领养 2 张预设 → 图鉴 adopted_count=2/18，未领养标记正确',
      a1.status === 201 && a2.status === 201 &&
        col.json && col.json.adopted_count === 2 && col.json.total === 18 &&
        col.json.presets.filter((p) => p.adopted).length === 2,
      `a=${a1.status},${a2.status} adopted=${col.json && col.json.adopted_count}`
    );
    for (const a of [a1, a2]) {
      const ch = a.json && a.json.character;
      if (ch) await req('DELETE', `/api/characters/${ch.id}`);
    }
    // 清理投稿角色
    const chars = await req('GET', '/api/characters');
    for (const c of (chars.json || []).filter((x) => x.name === '投稿测试角')) {
      await req('DELETE', `/api/characters/${c.id}`);
    }
  }
}

// ================= 多用户套件（13 项） =================
async function runMulti() {
  const jarA = makeJar(); // 用户 A
  let jarAdminM = null; // 管理员会话（M16 登录，M20/M21 复用）
  let jarB2b = null; // testuserB 重登录会话（M32 起复用，M23 的 jarB2 块级已失效）
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

  // M2b. 邀请注册前置：A 取邀请码 → C 用邀请码注册（放前面，避免后面限流）
  // 注意：jarA 在 M12 会退出登录，邀请码必须现在取
  let inviteCodeA = '';
  const jarC = makeJar();
  {
    const inv = await req('GET', '/api/invite', undefined, { jar: jarA });
    inviteCodeA = (inv.json && inv.json.code) || '';
    const r = await req('POST', '/api/auth/register', { username: 'testuserC', password: 'password123', inviteCode: inviteCodeA }, { jar: jarC });
    ok(
      'M2b. 邀请注册：A 取邀请码 → C 用邀请码注册 → 201',
      inv.status === 200 && inviteCodeA.length === 8 && r.status === 201,
      `invite=${inv.status} code=${inviteCodeA} reg=${r.status}(${JSON.stringify(r.json)})`
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

  // M14. 积分：注册奖励改首聊发放 → 新用户余额 0；默认 points 模式，白名单 3 模型
  {
    const p = await req('GET', '/api/points', undefined, { jar: jarB });
    ok(
      'M14. GET /api/points → balance 0（奖励首聊发）/ billing_mode=points / 3 个白名单模型',
      p.status === 200 && p.json && p.json.balance === 0 &&
        p.json.billing_mode === 'points' &&
        Array.isArray(p.json.models) && p.json.models.length === 3,
      JSON.stringify(p.json)
    );
  }

  // M15. 积分：切换计费方式
  {
    const bad = await req('PUT', '/api/points/mode', { mode: 'xxx' }, { jar: jarB });
    const toByok = await req('PUT', '/api/points/mode', { mode: 'byok' }, { jar: jarB });
    const back = await req('PUT', '/api/points/mode', { mode: 'points' }, { jar: jarB });
    const p = await req('GET', '/api/points', undefined, { jar: jarB });
    ok(
      'M15. PUT /api/points/mode：非法值 → 400；byok → 200；切回 points 生效',
      bad.status === 400 && toByok.status === 200 && back.status === 200 &&
        p.json && p.json.billing_mode === 'points',
      `bad=${bad.status} toByok=${toByok.status} back=${back.status} mode=${p.json && p.json.billing_mode}`
    );
  }

  // M16. 积分：管理员发放（testuserA 是首个用户=管理员）；非管理员 → 403
  // jarAdminM 提升到外层：M20/M21 复用（限流已满，不能再登录）
  {
    jarAdminM = makeJar();
    const login = await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarAdminM });
    const g = await req('POST', '/api/admin/points/grant', { username: 'testuserB', points: 100 }, { jar: jarAdminM });
    const forbidden = await req('POST', '/api/admin/points/grant', { username: 'testuserB', points: 100 }, { jar: jarB });
    const notFound = await req('POST', '/api/admin/points/grant', { username: 'nobody999', points: 100 }, { jar: jarAdminM });
    const p = await req('GET', '/api/points', undefined, { jar: jarB });
    ok(
      'M16. 管理员发放 100 → B 余额 100；非管理员 → 403；不存在的用户 → 404',
      login.status === 200 && g.status === 200 && g.json && g.json.balance === 100 &&
        forbidden.status === 403 && notFound.status === 404 &&
        p.json && p.json.balance === 100,
      `grant=${g.status}(${JSON.stringify(g.json)}) forbidden=${forbidden.status} notFound=${notFound.status} balance=${p.json && p.json.balance}`
    );
  }

  // M17. 积分：消费明细有发放记录（B 还没聊过天，signup_bonus 在 M27 首聊后才有）
  {
    const l = await req('GET', '/api/points/ledger?limit=20', undefined, { jar: jarB });
    const reasons = Array.isArray(l.json) ? l.json.map((r) => r.reason) : [];
    ok(
      'M17. GET /api/points/ledger → 含 admin_grant，带中文 reason_label',
      l.status === 200 && reasons.includes('admin_grant') &&
        l.json.every((r) => typeof r.reason_label === 'string' && r.reason_label),
      `reasons=${reasons.join(',')}`
    );
  }

  // M18. 积分模式聊天（mock）：200 + done；未登录 → 401
  {
    const rc = await req('POST', `/api/characters/${charB}/conversations`, { title: '积分聊天' }, { jar: jarB });
    const convP = rc.json && rc.json.id;
    const { status, events } = await postSSE(`/api/conversations/${convP}/messages`, { content: '积分模式 hello' }, { jar: jarB });
    const done = events.find((e) => e.event === 'done');
    const noAuth = await postSSE(`/api/conversations/${convP}/messages`, { content: 'x' });
    ok(
      'M18. 积分模式聊天 → 200 且 done；未登录 → 401',
      status === 200 && !!done && noAuth.status === 401,
      `status=${status} events=${events.map((e) => e.event).join(',')} noAuth=${noAuth.status}`
    );
  }

  // M19. 邀请验证：C 还没聊过 → 余额 0，奖励首聊后才发
  {
    const p = await req('GET', '/api/points', undefined, { jar: jarC });
    const l = await req('GET', '/api/points/ledger?limit=5', undefined, { jar: jarC });
    const reasons = Array.isArray(l.json) ? l.json.map((x) => x.reason) : [];
    ok(
      'M19. 邀请注册验证：C 未聊天 → 余额 0，账本暂无 signup_bonus/invite_bonus',
      p.json && p.json.balance === 0 && !reasons.includes('signup_bonus') && !reasons.includes('invite_bonus'),
      `balance=${p.json && p.json.balance} reasons=${reasons.join(',')}`
    );
  }

  // M20. 邀请奖励：C 聊满 10 条 → A 收到 invite_reward 200；再聊不重复发
  {
    const cc = await req('POST', '/api/characters', { name: '小邀' }, { jar: jarC });
    const charC = cc.json && cc.json.id;
    const cv = await req('POST', `/api/characters/${charC}/conversations`, {}, { jar: jarC });
    const convC = cv.json && cv.json.id;
    for (let i = 0; i < 11; i++) {
      await postSSE(`/api/conversations/${convC}/messages`, { content: `第${i + 1}条` }, { jar: jarC });
    }
    const la = await req('GET', '/api/points/ledger?limit=100', undefined, { jar: jarAdminM });
    const rewards = Array.isArray(la.json) ? la.json.filter((x) => x.reason === 'invite_reward') : [];
    const total = rewards.reduce((s, x) => s + x.delta, 0);
    ok(
      'M20. C 聊满 10 条 → A 收到 invite_reward 200（幂等，只发一次）',
      rewards.length === 1 && total === 200 && rewards[0].reason_label === '邀请奖励',
      `rewards=${rewards.length} total=${total}`
    );
  }

  // M21. 统计：管理员 4 个接口 → 200；非管理员 → 403；未登录 → 401
  {
    const jarAdmin = jarAdminM; // testuserA 是首个用户=管理员（M16 已登录，复用避开限流）
    const ov = await req('GET', '/api/admin/stats/overview', undefined, { jar: jarAdmin });
    const da = await req('GET', '/api/admin/stats/daily?days=7', undefined, { jar: jarAdmin });
    const mo = await req('GET', '/api/admin/stats/models', undefined, { jar: jarAdmin });
    const tu = await req('GET', '/api/admin/stats/top-users?limit=5', undefined, { jar: jarAdmin });
    const forbidden = await req('GET', '/api/admin/stats/overview', undefined, { jar: jarB });
    const noAuth = await req('GET', '/api/admin/stats/overview');
    ok(
      'M21. 统计：admin 4 接口 → 200；非管理员 → 403；未登录 → 401',
      ov.status === 200 && typeof ov.json.totalUsers === 'number' && ov.json.totalUsers >= 3 &&
        da.status === 200 && Array.isArray(da.json) && da.json.length === 7 &&
        mo.status === 200 && Array.isArray(mo.json) &&
        tu.status === 200 && Array.isArray(tu.json) &&
        forbidden.status === 403 && noAuth.status === 401,
      `ov=${ov.status} users=${ov.json && ov.json.totalUsers} daily=${da.json && da.json.length} models=${mo.status} top=${tu.status} forbidden=${forbidden.status} noAuth=${noAuth.status}`
    );
  }

  // M22. 账本新字段：ledger 行带 tokens_input/tokens_output/model 键
  {
    const l = await req('GET', '/api/points/ledger?limit=1', undefined, { jar: jarB });
    const row = Array.isArray(l.json) && l.json[0];
    ok(
      'M22. GET /api/points/ledger 行含 tokens_input/tokens_output/model 字段',
      l.status === 200 && !!row && 'tokens_input' in row && 'tokens_output' in row && 'model' in row,
      `keys=${row ? Object.keys(row).join(',') : 'none'}`
    );
  }

  // M23. 密码重置：B 取重置码（12 位）→ 错码 401 → 正确 200（轮换新码）→ 旧会话失效 → 新密码可登录
  {
    const rc = await req('GET', '/api/auth/recovery-code', undefined, { jar: jarB });
    const code = rc.json && rc.json.recovery_code;
    const wrong = await req('POST', '/api/auth/reset-password', { username: 'testuserB', recovery_code: 'WRONGCODE12', new_password: 'newpassword123' });
    const good = await req('POST', '/api/auth/reset-password', { username: 'testuserB', recovery_code: code, new_password: 'newpassword123' });
    const newCode = good.json && good.json.recovery_code;
    const meAfter = await req('GET', '/api/auth/me', undefined, { jar: jarB });
    const jarB2 = makeJar();
    const login = await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB2 });
    ok(
      'M23. 重置码 12 位 → 错码 401 → 正确 200 且轮换新码 → 旧会话 401 → 新密码登录 200',
      rc.status === 200 && typeof code === 'string' && code.length === 12 &&
        wrong.status === 401 && good.status === 200 && typeof newCode === 'string' && newCode.length === 12 && newCode !== code &&
        meAfter.status === 401 && login.status === 200,
      `code=${code} wrong=${wrong.status} good=${good.status} newCode=${newCode} meAfter=${meAfter.status} login=${login.status}`
    );
    // M24. 查看/重生重置码：GET 与轮换后一致 → 重生得不同码 → GET 返回新码
    const g1 = await req('GET', '/api/auth/recovery-code', undefined, { jar: jarB2 });
    const rg = await req('POST', '/api/auth/recovery-code/regenerate', {}, { jar: jarB2 });
    const g2 = await req('GET', '/api/auth/recovery-code', undefined, { jar: jarB2 });
    const regen = rg.json && rg.json.recovery_code;
    ok(
      'M24. GET 重置码 = 轮换后新码 → 重生得不同 12 位码 → GET 返回新码',
      g1.status === 200 && g1.json.recovery_code === newCode &&
        rg.status === 200 && typeof regen === 'string' && regen.length === 12 && regen !== newCode &&
        g2.json.recovery_code === regen,
      `g1=${g1.json && g1.json.recovery_code} regen=${regen} g2=${g2.json && g2.json.recovery_code}`
    );
    // M26. SSRF：非法 baseUrl 入库 400（内网/非 https/元数据），合法 https 公网 200
    const bad1 = await req('PUT', '/api/user/api-key', { baseUrl: 'https://169.254.169.254/x' }, { jar: jarB2 });
    const bad2 = await req('PUT', '/api/user/api-key', { baseUrl: 'http://openrouter.ai/api' }, { jar: jarB2 });
    const bad3 = await req('PUT', '/api/user/api-key', { baseUrl: 'https://localhost:11434/v1' }, { jar: jarB2 });
    const good2 = await req('PUT', '/api/user/api-key', { baseUrl: 'https://openrouter.ai/api/v1' }, { jar: jarB2 });
    ok(
      'M26. 非法 baseUrl（元数据/http/localhost）→ 400；合法 https 公网 → 200',
      bad1.status === 400 && bad2.status === 400 && bad3.status === 400 && good2.status === 200,
      `bad1=${bad1.status} bad2=${bad2.status} bad3=${bad3.status} good=${good2.status}`
    );
    // M27. 注册奖励首聊发放：B（已获 grant 100，未领注册奖励）聊一条 → +500，账本有 signup_bonus
    const chB = await req('POST', '/api/characters', { name: '小测' }, { jar: jarB2 });
    const charB2 = chB.json && chB.json.id;
    const cvB = await req('POST', `/api/characters/${charB2}/conversations`, {}, { jar: jarB2 });
    const convB = cvB.json && cvB.json.id;
    await postSSE(`/api/conversations/${convB}/messages`, { content: '你好' }, { jar: jarB2 });
    const pb = await req('GET', '/api/points', undefined, { jar: jarB2 });
    const lb = await req('GET', '/api/points/ledger?limit=5', undefined, { jar: jarB2 });
    const reasonsB = Array.isArray(lb.json) ? lb.json.map((x) => x.reason) : [];
    ok(
      'M27. 首聊后注册奖励到账：B 余额 100+500=600，账本有 signup_bonus',
      pb.json && pb.json.balance === 600 && reasonsB.includes('signup_bonus'),
      `balance=${pb.json && pb.json.balance} reasons=${reasonsB.join(',')}`
    );
  }

  // M25. 管理员模型 CRUD：查 → 增 → 改价 → 下架（公开列表消失）→ 删除；非管理员 403
  {
    const jarAdmin = jarAdminM;
    const list0 = await req('GET', '/api/admin/points/models', undefined, { jar: jarAdmin });
    const n0 = Array.isArray(list0.json) ? list0.json.length : -1;
    const add = await req('POST', '/api/admin/points/models', { model_id: 'test/model-x', name: '测试模型', input_per_1m: 100, output_per_1m: 200 }, { jar: jarAdmin });
    const newId = add.json && add.json.id;
    const upd = await req('PUT', `/api/admin/points/models/${newId}`, { input_per_1m: 111 }, { jar: jarAdmin });
    const off = await req('PUT', `/api/admin/points/models/${newId}`, { is_active: 0 }, { jar: jarAdmin });
    const pub = await req('GET', '/api/points', undefined, { jar: jarAdmin });
    const pubIds = ((pub.json && pub.json.models) || []).map((m) => m.id);
    const del = await req('DELETE', `/api/admin/points/models/${newId}`, undefined, { jar: jarAdmin });
    const forbidden = await req('POST', '/api/admin/points/models', { model_id: 'x/y', name: 'x' }, { jar: jarC });
    ok(
      'M25. 模型 CRUD：列表 200 → 新增 200 → 改价 200 → 下架后公开列表无 → 删除 200；非管理员 403',
      list0.status === 200 && n0 >= 3 && add.status === 200 && newId &&
        upd.status === 200 && off.status === 200 && !pubIds.includes('test/model-x') &&
        del.status === 200 && forbidden.status === 403,
      `n0=${n0} add=${add.status} upd=${upd.status} off=${off.status} del=${del.status} forbidden=${forbidden.status}`
    );
  }

  // M28. 角色卡权限：预设列表公开（未登录 200）；领养/生成未登录 → 401
  {
    const pub = await req('GET', '/api/character-cards/presets');
    const noAdopt = await req('POST', '/api/character-cards/adopt', { preset_id: 'luchen' });
    const noGen = await req('POST', '/api/character-cards/generate', { prompt: '测试' });
    ok(
      'M28. 预设列表未登录 → 200（18 张）；adopt/generate 未登录 → 401',
      pub.status === 200 && Array.isArray(pub.json.cards) && pub.json.cards.length === 18 &&
        noAdopt.status === 401 && noGen.status === 401,
      `pub=${pub.status} n=${pub.json && pub.json.cards && pub.json.cards.length} adopt=${noAdopt.status} gen=${noGen.status}`
    );
  }

  // M29. 登录后领养：201 且链路完整；其他用户查该角色 → 404（隔离）
  {
    const ad = await req('POST', '/api/character-cards/adopt', { preset_id: 'taoyao' }, { jar: jarC });
    const ch = ad.json && ad.json.character;
    const conv = ad.json && ad.json.conversation;
    const msgs = conv ? await req('GET', `/api/conversations/${conv.id}/messages`, undefined, { jar: jarC }) : null;
    const other = ch ? await req('GET', `/api/characters/${ch.id}`, undefined, { jar: jarAdminM }) : null;
    ok(
      'M29. 登录后 adopt → 201：角色/对话/开场白齐全；其他用户查 → 404',
      ad.status === 201 && ch && ch.name === '桃夭' && conv && conv.id &&
        Array.isArray(msgs.json) && msgs.json.length === 1 && msgs.json[0].role === 'assistant' &&
        other.status === 404,
      `adopt=${ad.status} name=${ch && ch.name} msgs=${msgs && msgs.json && msgs.json.length} other=${other && other.status}`
    );
  }

  // M30. AI 生成（mock）：200 且卡完整；非法模型回退到 worker；mock 不扣费（cost null）
  {
    const g = await req('POST', '/api/character-cards/generate', { prompt: '一只会社畜的柴犬', model: 'nope/not-real' }, { jar: jarC });
    const card = g.json && g.json.card;
    const g2 = await req('POST', '/api/character-cards/generate', { prompt: '' }, { jar: jarC });
    ok(
      'M30. generate（mock）→ 200：卡完整，非法模型回退可用，cost 为 null；空 prompt → 400',
      g.status === 200 && card && card.name && card.greeting && card.soul_md &&
        Array.isArray(card.example_dialogues) && g.json.cost === null && g2.status === 400,
      `gen=${g.status} name=${card && card.name} cost=${JSON.stringify(g.json && g.json.cost)} empty=${g2.status}`
    );
  }

  // M31. 广场发布（多用户先审后发）：publish → pending；未登录列表不可见；admin 通过 → 可见；非 admin 审核 → 403
  let mSharedId = null;
  {
    const ch = await req('POST', '/api/characters', { name: '广场投稿角' }, { jar: jarC });
    const charId = ch.json.id;
    const pub = await req('POST', '/api/character-cards/publish', {
      character_id: charId,
      tagline: '多用户测试投稿',
      description: '回归测试用投稿卡片，简介凑字数凑字数凑字数凑字数凑字数凑字数。',
      greeting: '多用户测试开场白，你好呀！',
    }, { jar: jarC });
    mSharedId = pub.json && pub.json.id;
    const pubListAnon = await req('GET', '/api/character-cards/shared');
    const forbidden = await req('POST', `/api/admin/shared-cards/${mSharedId}/review`, { approve: true }, { jar: jarC });
    const pendList = await req('GET', '/api/admin/shared-cards?status=pending', undefined, { jar: jarAdminM });
    const approve = await req('POST', `/api/admin/shared-cards/${mSharedId}/review`, { approve: true }, { jar: jarAdminM });
    const pubListAfter = await req('GET', '/api/character-cards/shared');
    ok(
      'M31. publish → pending；未登录列表无；非 admin 审核 → 403；admin 待审列表有；通过后列表可见',
      pub.status === 201 && pub.json.status === 'pending' && mSharedId &&
        Array.isArray(pubListAnon.json) && pubListAnon.json.length === 0 &&
        forbidden.status === 403 &&
        Array.isArray(pendList.json) && pendList.json.some((x) => x.id === mSharedId) &&
        approve.status === 200 &&
        pubListAfter.json.some((x) => x.id === mSharedId),
      `pub=${pub.status} anon=${pubListAnon.json && pubListAnon.json.length} forbidden=${forbidden.status} approve=${approve.status} after=${pubListAfter.json && pubListAfter.json.length}`
    );
  }

  // M32. 领养广场卡 → 201 且 adopt_count+1；我的投稿可见；作者可删除
  {
    jarB2b = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB2b });
    const ad = await req('POST', `/api/character-cards/shared/${mSharedId}/adopt`, {}, { jar: jarB2b });
    const my = await req('GET', '/api/character-cards/my-published', undefined, { jar: jarC });
    const like = await req('POST', `/api/character-cards/shared/${mSharedId}/like`, {}, { jar: jarB2b });
    const delOther = await req('DELETE', `/api/character-cards/shared/${mSharedId}`, undefined, { jar: jarB2b });
    const del = await req('DELETE', `/api/character-cards/shared/${mSharedId}`, undefined, { jar: jarC });
    const after = await req('GET', '/api/character-cards/shared');
    ok(
      'M32. 他人领养 → 201；作者我的投稿有 1 条；点赞 ok；非作者删 → 404；作者删 → 200；列表空',
      ad.status === 201 && ad.json.character && ad.json.character.name === '广场投稿角' &&
        Array.isArray(my.json) && my.json.length === 1 && my.json[0].adopt_count === 1 &&
        like.json.liked === true &&
        delOther.status === 404 && del.status === 200 &&
        Array.isArray(after.json) && after.json.length === 0,
      `ad=${ad.status} my=${my.json && my.json.length} like=${like.json && like.json.liked} del=${delOther.status},${del.status}`
    );
    const ch = ad.json && ad.json.character;
    if (ch) await req('DELETE', `/api/characters/${ch.id}`, undefined, { jar: jarB2b });
  }

  // M33. 敏感词投稿 → 400；举报 5 次自动下架回 pending
  {
    const ch = await req('POST', '/api/characters', { name: '敏感词角' }, { jar: jarC });
    const bad = await req('POST', '/api/character-cards/publish', {
      character_id: ch.json.id,
      tagline: '约炮神器来了',
      description: '简介凑字数凑字数凑字数凑字数凑字数凑字数凑字数。',
      greeting: '开场白凑字数凑字数凑字数。',
    }, { jar: jarC });
    const pub = await req('POST', '/api/character-cards/publish', {
      character_id: ch.json.id,
      tagline: '正常投稿卡',
      description: '简介凑字数凑字数凑字数凑字数凑字数凑字数凑字数。',
      greeting: '正常开场白，你好呀！',
    }, { jar: jarC });
    const sid = pub.json.id;
    await req('POST', `/api/admin/shared-cards/${sid}/review`, { approve: true }, { jar: jarAdminM });
    for (let i = 0; i < 5; i++) await req('POST', `/api/character-cards/shared/${sid}/report`, { reason: '测试' }, { jar: jarB2b });
    const list = await req('GET', '/api/character-cards/shared');
    const pend = await req('GET', '/api/admin/shared-cards?status=pending', undefined, { jar: jarAdminM });
    ok(
      'M33. 敏感词投稿 → 400；举报 5 次 → 广场列表消失且回待审队列',
      bad.status === 400 && /敏感词/.test(bad.json.error || '') &&
        pub.status === 201 &&
        Array.isArray(list.json) && !list.json.some((x) => x.id === sid) &&
        pend.json.some((x) => x.id === sid),
      `bad=${bad.status} list=${list.json && list.json.length} backToPending=${pend.json.some((x) => x.id === sid)}`
    );
    await req('DELETE', `/api/characters/${ch.json.id}`, undefined, { jar: jarC });
  }

  // M34. 集卡奖励：领养全部 18 张预设 → 账本 collection_reward +200（幂等，不重复发）
  {
    const presets = await req('GET', '/api/character-cards/presets');
    const ids = presets.json.cards.map((c) => c.id);
    for (const pid of ids) {
      await req('POST', '/api/character-cards/adopt', { preset_id: pid }, { jar: jarB2b });
    }
    const ledger = await req('GET', '/api/points/ledger?limit=100', undefined, { jar: jarB2b });
    const rewards = (Array.isArray(ledger.json) ? ledger.json : []).filter((x) => x.reason === 'collection_reward');
    const col = await req('GET', '/api/character-cards/collection', undefined, { jar: jarB2b });
    // 再领养一次已有点亮的卡，不重复发奖
    await req('POST', '/api/character-cards/adopt', { preset_id: ids[0] }, { jar: jarB2b });
    const ledger2 = await req('GET', '/api/points/ledger?limit=100', undefined, { jar: jarB2b });
    const rewards2 = (Array.isArray(ledger2.json) ? ledger2.json : []).filter((x) => x.reason === 'collection_reward');
    ok(
      'M34. 集齐 18 张预设 → collection_reward +200（仅一次）；图鉴 18/18 且 reward_claimed',
      rewards.length === 1 && rewards[0].delta === 200 && rewards[0].reason_label === '集卡奖励' &&
        col.json && col.json.adopted_count === 18 && col.json.reward_claimed === true &&
        rewards2.length === 1,
      `rewards=${rewards.length} delta=${rewards[0] && rewards[0].delta} adopted=${col.json && col.json.adopted_count} again=${rewards2.length}`
    );
  }

  // M35. 管理员打回：填理由 → 我的投稿显示 rejected + 理由
  {
    const ch = await req('POST', '/api/characters', { name: '打回测试角' }, { jar: jarC });
    const pub = await req('POST', '/api/character-cards/publish', {
      character_id: ch.json.id,
      tagline: '待打回的投稿',
      description: '简介凑字数凑字数凑字数凑字数凑字数凑字数凑字数。',
      greeting: '打回测试开场白，你好呀！',
    }, { jar: jarC });
    const sid = pub.json.id;
    const noReason = await req('POST', `/api/admin/shared-cards/${sid}/review`, { approve: false }, { jar: jarAdminM });
    // 前端会拦，但接口层 reason 缺省给默认文案，不断言 400
    const my = await req('GET', '/api/character-cards/my-published', undefined, { jar: jarC });
    const mine = (Array.isArray(my.json) ? my.json : []).find((x) => x.id === sid);
    ok(
      'M35. 管理员打回 → 我的投稿显示 rejected 且有理由',
      noReason.status === 200 && mine && mine.status === 'rejected' && !!mine.reject_reason,
      `review=${noReason.status} status=${mine && mine.status} reason=${mine && mine.reject_reason}`
    );
    await req('DELETE', `/api/characters/${ch.json.id}`, undefined, { jar: jarC });
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
