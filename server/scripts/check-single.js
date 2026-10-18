import { ok, req, postSSE, makeJar, parseSSE, base, getDb, getConfig, estimateTokens, summarizeOld, runMemoryPipeline, retrieveFacts, llmCreds, encryptSecret, decryptSecret } from './check-lib.js';

export async function runSingle() {
  let charId = null;
  let convId = null;

  // 0. v0.2.1 版本号同步锁：/api/config.version 必须等于 server/package.json（设置面板直接读它）
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
    const r = await req('GET', '/api/config');
    ok(
      '0. 版本号同步：/api/config.version 与 server/package.json 一致',
      r.status === 200 && r.json && r.json.version === pkg.version,
      `config version=${r.json && r.json.version} pkg=${pkg.version}`
    );
  }

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

  // 10. v1.10：4 轮闲聊 → done 先回；事件驱动 gate 跳过无价值轮，memory_facts 为空（不再全文重写）
  {
    const texts = ['今天天气真不错', '你喜欢什么颜色', '讲个简短的笑话', '好的再见'];
    let fifthEvents = null;
    for (let i = 0; i < texts.length; i++) {
      const { events } = await postSSE(`/api/conversations/${convId}/messages`, { content: texts[i] });
      if (i === texts.length - 1) fifthEvents = events;
    }
    const hasDone = fifthEvents.some((e) => e.event === 'done');
    const noMemEv = !fifthEvents.some((e) => e.event === 'memory_updated');
    // 等后台流水线（setImmediate + mock）完成
    await new Promise((r) => setTimeout(r, 1000));
    const db = getDb();
    const factCount = db.prepare('SELECT COUNT(*) AS n FROM memory_facts WHERE character_id = ?').get(charId).n;
    const suggCount = db.prepare("SELECT COUNT(*) AS n FROM intent_suggestions WHERE character_id = ? AND status = 'pending'").get(charId).n;
    ok(
      '10. v1.10：闲聊轮 done 先回；gate 跳过 → facts 为空、无建议（零无效重写）',
      hasDone && noMemEv && factCount === 0 && suggCount === 0,
      `events=${fifthEvents.map((e) => e.event).join(',')} facts=${factCount} suggestions=${suggCount}`
    );
  }

  // 10b. v1.10 意图识别：用户说"设定：让她怕黑" → 生成待确认的灵魂修改建议（不自动改 soul）
  {
    const before = await req('GET', `/api/characters/${charId}/files`);
    const soulBefore = before.json.soul_md;
    const changes = await runMemoryPipeline(
      { id: charId, name: '小灵', soul_md: soulBefore, user_md: before.json.user_md },
      convId,
      '设定：让她怕黑',
      { model: 'mock', userId: null }
    );
    const sg = await req('GET', `/api/characters/${charId}/suggestions`);
    const after = await req('GET', `/api/characters/${charId}/files`);
    ok(
      '10b. 意图识别：soul_update 意图 → 建议 pending；soul_md 未被自动修改',
      changes.suggestion && changes.suggestion.proposed.includes('怕黑') &&
        Array.isArray(sg.json) && sg.json.length === 1 && sg.json[0].proposed.includes('怕黑') &&
        after.json.soul_md === soulBefore,
      `suggestion=${JSON.stringify(changes.suggestion)} list=${sg.json.length} soulUnchanged=${after.json.soul_md === soulBefore}`
    );
    // 一键写入灵魂
    const sid = sg.json[0].id;
    const ap = await req('POST', `/api/suggestions/${sid}/apply`);
    const files2 = await req('GET', `/api/characters/${charId}/files`);
    const sg2 = await req('GET', `/api/characters/${charId}/suggestions`);
    ok(
      '10c. 一键写入灵魂：soul_md 追加"对话补充设定"小节；建议变 applied；列表清空',
      ap.status === 200 &&
        files2.json.soul_md.includes('## 对话补充设定') && files2.json.soul_md.includes('怕黑') &&
        Array.isArray(sg2.json) && sg2.json.length === 0,
      `apply=${ap.status} hasSection=${files2.json.soul_md.includes('## 对话补充设定')} pending=${sg2.json.length}`
    );
    // dismiss 不存在的 → 404
    const badDismiss = await req('POST', '/api/suggestions/999999/dismiss');
    ok('10d. dismiss 不存在的建议 → 404', badDismiss.status === 404, `status=${badDismiss.status}`);
  }

  // 10e. v1.10 事件驱动提取："记住" → worth=true → user_md 更新 + fact 落库（ADD）
  {
    const changes = await runMemoryPipeline(
      { id: charId, name: '小灵', soul_md: '', user_md: '' },
      convId,
      '记住：我喜欢打篮球',
      { model: 'mock', userId: null }
    );
    const db = getDb();
    const facts = db.prepare('SELECT fact FROM memory_facts WHERE character_id = ? AND superseded_by IS NULL').all(charId);
    ok(
      '10e. "记住"触发提取：user_md 变化 + 1 条 fact 落库',
      changes.userMdChanged === true && changes.factsAdded === 1 && facts.length >= 1,
      `userMdChanged=${changes.userMdChanged} factsAdded=${changes.factsAdded} rows=${facts.length}`
    );
  }

  // 10f. v1.10 检索：相关进、无关不进
  {
    const db = getDb();
    db.prepare('INSERT INTO memory_facts(character_id, fact, importance, created_at, source) VALUES(?,?,?,?,?)').run(
      charId, '小灵最爱吃的是牛肉拉面', 4, new Date().toISOString(), 'test'
    );
    const rel = retrieveFacts(charId, convId, '拉面好吃吗', 8);
    const irr = retrieveFacts(charId, convId, '今天天气不错', 8);
    ok(
      '10f. 检索：相关 fact 命中；无关查询返回空（治上下文污染）',
      rel.length >= 1 && rel.some((f) => f.fact.includes('拉面')) && irr.length === 0,
      `rel=${rel.length} irr=${irr.length}`
    );
  }

  // 10g. v1.10 矛盾替代：SUPERSEDE 标记旧 fact
  {
    const db = getDb();
    const old = db.prepare('INSERT INTO memory_facts(character_id, fact, importance, created_at, source) VALUES(?,?,?,?,?)').run(
      charId, '用户住在北京', 3, new Date().toISOString(), 'test'
    );
    const oldId = Number(old.lastInsertRowid);
    // 模拟 LLM 返回 SUPERSEDE
    const now = new Date().toISOString();
    const ins = db.prepare('INSERT INTO memory_facts(character_id, fact, importance, created_at, source) VALUES(?,?,?,?,?)').run(
      charId, '用户搬到了上海', 4, now, 'chat'
    );
    db.prepare('UPDATE memory_facts SET superseded_by = ? WHERE id = ?').run(Number(ins.lastInsertRowid), oldId);
    const visible = db.prepare('SELECT fact FROM memory_facts WHERE character_id = ? AND superseded_by IS NULL AND fact LIKE ?').all(charId, '%上海%');
    const hidden = db.prepare('SELECT fact FROM memory_facts WHERE id = ? AND superseded_by IS NULL').get(oldId);
    const rel = retrieveFacts(charId, convId, '用户住在哪里', 8);
    ok(
      '10g. SUPERSEDE：旧 fact 被标记，检索只返回新 fact',
      visible.length === 1 && !hidden && rel.every((f) => !f.fact.includes('北京')),
      `visible=${visible.length} hidden=${!hidden} relHasBeijing=${rel.some((f) => f.fact.includes('北京'))}`
    );
  }

  // 10h. v1.11 事实列表接口：GET 返回条目（含 importance/时间字段）
  {
    const db = getDb();
    const ins = db.prepare('INSERT INTO memory_facts(character_id, fact, importance, created_at, source) VALUES(?,?,?,?,?)').run(
      charId, 'v1.11 测试事实：用户周五晚上有空', 5, new Date().toISOString(), 'test'
    );
    const fid = Number(ins.lastInsertRowid);
    const r = await req('GET', `/api/characters/${charId}/facts`);
    const item = (Array.isArray(r.json) ? r.json : []).find((f) => f.id === fid);
    ok(
      '10h. GET /api/characters/:id/facts → 200，包含刚写入的 fact（含 importance/created_at）',
      r.status === 200 && !!item && item.fact.includes('周五') && item.importance === 5 && !!item.created_at,
      `status=${r.status} found=${!!item} imp=${item && item.importance}`
    );
    // ?all=1 也能拿到；被替代的不在默认列表里
    const rAll = await req('GET', `/api/characters/${charId}/facts?all=1`);
    ok(
      '10i. GET facts?all=1 → 200，返回数组',
      rAll.status === 200 && Array.isArray(rAll.json),
      `status=${rAll.status} len=${rAll.json && rAll.json.length}`
    );
    // 删除
    const del1 = await req('DELETE', `/api/facts/${fid}`);
    const r2 = await req('GET', `/api/characters/${charId}/facts`);
    const gone = !(Array.isArray(r2.json) ? r2.json : []).some((f) => f.id === fid);
    const del2 = await req('DELETE', `/api/facts/${fid}`);
    const delBad = await req('DELETE', '/api/facts/999999');
    ok(
      '10j. DELETE /api/facts/:id → 200 且列表不再包含；重复删/删不存在 → 404',
      del1.status === 200 && gone && del2.status === 404 && delBad.status === 404,
      `del1=${del1.status} gone=${gone} del2=${del2.status} delBad=${delBad.status}`
    );
  }

  // 10k. v1.12 记忆事件：流水线有写入 → memory_events 落库
  {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM memory_events WHERE conversation_id = ?').get(convId).n;
    await runMemoryPipeline(
      { id: charId, name: '小灵', soul_md: '', user_md: '' },
      convId,
      '记住：v1.12 测试事件',
      { model: 'mock', userId: null }
    );
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM memory_events WHERE conversation_id = ?').get(convId).n;
    ok(
      '10k. 流水线有写入 → memory_events 新增 1 条',
      after === before + 1,
      `before=${before} after=${after}`
    );
  }

  // 10l. v1.12 记忆事件接口：since 过滤 + 带角色名
  {
    const since = new Date(Date.now() - 60000).toISOString();
    const r = await req('GET', `/api/conversations/${convId}/memory-events?since=${encodeURIComponent(since)}`);
    const items = Array.isArray(r.json) ? r.json : [];
    const rOld = await req('GET', `/api/conversations/${convId}/memory-events?since=${encodeURIComponent(new Date().toISOString())}`);
    const bad = await req('GET', '/api/conversations/nope/memory-events');
    ok(
      '10l. GET memory-events → 200 且含角色名；since=未来 → 空；不存在的对话 → 404',
      r.status === 200 && items.length >= 1 && !!items[0].character_name &&
        Array.isArray(rOld.json) && rOld.json.length === 0 && bad.status === 404,
      `status=${r.status} n=${items.length} name=${items[0] && items[0].character_name} future=${rOld.json && rOld.json.length} bad=${bad.status}`
    );
  }

  // 10m. v1.12.1 模板注释 facts 清理：污染条目被删，真实条目保留
  {
    const db = getDb();
    const mk = (fact) => db.prepare('INSERT INTO memory_facts(character_id, fact, importance, created_at, source) VALUES(?,?,?,?,?)').run(charId, fact, 3, new Date().toISOString(), 'test').lastInsertRowid;
    const p1 = mk('此文本框保留做兼容：手动填写的内容不会被 AI 读取');
    const p2 = mk('<!-- 记忆：v1.10 起已升级为 AI 自动条目');
    const real = mk('v1.12.1 真实记忆：用户约了周五看电影');
    // 与 db.js 启动清理相同的 SQL
    const del = db.prepare(`DELETE FROM memory_facts WHERE fact LIKE '%此文本框保留做兼容%' OR fact LIKE '<!--%'`).run();
    const gone1 = !db.prepare('SELECT id FROM memory_facts WHERE id = ?').get(p1);
    const gone2 = !db.prepare('SELECT id FROM memory_facts WHERE id = ?').get(p2);
    const kept = !!db.prepare('SELECT id FROM memory_facts WHERE id = ?').get(real);
    // FTS 索引同步清理：搜污染词应无结果（trigram 需 3 字）
    const fts = db.prepare(`SELECT rowid FROM memory_facts_fts WHERE memory_facts_fts MATCH ?`).all('做兼容');
    db.prepare('DELETE FROM memory_facts WHERE id = ?').run(real);
    ok(
      '10m. 注释 facts 清理：2 条污染删除、真实保留、FTS 同步',
      del.changes >= 2 && gone1 && gone2 && kept && fts.length === 0,
      `del=${del.changes} gone=${gone1 && gone2} kept=${kept} ftsLeft=${fts.length}`
    );
  }

  // 10n. v1.12.1 互斥规则：extract prompt 明确画像/事件分开记
  {
    const { FACTS_SYSTEM } = await import('../src/llm.js');
    ok(
      '10n. FACTS_SYSTEM 包含互斥规则（画像只进 user_md，事件只进 facts）',
      FACTS_SYSTEM.includes('互斥') && FACTS_SYSTEM.includes('只进 user_md') && FACTS_SYSTEM.includes('只进 facts'),
      `hasMutualExclusion=${FACTS_SYSTEM.includes('互斥')}`
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

  // 22. 预设角色卡列表：5 张员工卡 + 1 个分类
  {
    const r = await req('GET', '/api/character-cards/presets');
    const cats = r.json && r.json.categories;
    ok(
      '22. GET /api/character-cards/presets → 200，5 张员工卡，1 个分类',
      r.status === 200 && Array.isArray(r.json.cards) && r.json.cards.length === 5 &&
        cats && Object.keys(cats).length === 1 &&
        r.json.cards.every((c) => c.id && c.name && c.greeting && c.soul_md && cats[c.category]),
      `status=${r.status} n=${r.json && r.json.cards && r.json.cards.length}`
    );
  }

  // 23. 一键领养：建角色 + 建对话 + 开场白首条消息
  {
    const r = await req('POST', '/api/character-cards/adopt', { preset_id: 'shenyan' });
    const ch = r.json && r.json.character;
    const conv = r.json && r.json.conversation;
    const msgs = conv ? await req('GET', `/api/conversations/${conv.id}/messages`) : null;
    const first = msgs && msgs.json && msgs.json[0];
    ok(
      '23. POST adopt 预设卡 → 201：角色/对话/开场白消息齐全',
      r.status === 201 && ch && ch.name === '沈砚' && conv && conv.id &&
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

    // v1.16.0: 灵魂生成接口
    const sr = await req('POST', '/api/soul/generate', { prompt: '一只会讲冷笑话的猫耳女仆' });
    ok(
      '25c. POST /api/soul/generate（mock）→ 200：返回 soul_md',
      sr.status === 200 && sr.json && typeof sr.json.soul_md === 'string' && sr.json.soul_md.length > 10,
      `status=${sr.status} len=${sr.json && sr.json.soul_md && sr.json.soul_md.length}`
    );
    const sEmpty = await req('POST', '/api/soul/generate', { prompt: '' });
    ok('25d. soul/generate 空 prompt → 400', sEmpty.status === 400, `status=${sEmpty.status}`);

    // v1.16.0: 新建角色支持 soul_md / user_md / roleplay_mode
    const cr = await req('POST', '/api/characters', {
      name: '测试魂',
      avatar: '/avatars/avatar-gen-5.png',
      soul_md: '## 身份\n猫耳女仆',
      user_md: '叫我主人',
      roleplay_mode: 1,
    });
    const created = cr.json || {};
    const dbRow = getDb()
      .prepare('SELECT soul_md, user_md, roleplay_mode, avatar FROM characters WHERE id = ?')
      .get(created.id);
    ok(
      '25e. POST /api/characters → soul/user_md/roleplay_mode/avatar 落库',
      cr.status === 201 &&
        dbRow && dbRow.soul_md.includes('猫耳女仆') &&
        dbRow.user_md === '叫我主人' &&
        Number(dbRow.roleplay_mode) === 1 &&
        dbRow.avatar === '/avatars/avatar-gen-5.png',
      `status=${cr.status} rp=${dbRow && dbRow.roleplay_mode}`
    );
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

  // 27. 广场互动：列表可见 → 领养（adopt_count+1）→ 点赞/取消 → 举报去重（v1.28.1: 同人连点只算1次）→ 5个不同用户举报才下架
  {
    const list0 = await req('GET', '/api/character-cards/shared');
    const ad = await req('POST', `/api/character-cards/shared/${sharedId}/adopt`);
    const like1 = await req('POST', `/api/character-cards/shared/${sharedId}/like`);
    const like2 = await req('POST', `/api/character-cards/shared/${sharedId}/like`);
    // 同一用户连点 5 次 → 只记 1 次，卡片不下架
    for (let i = 0; i < 5; i++) await req('POST', `/api/character-cards/shared/${sharedId}/report`, { reason: '测试举报' });
    const db = getDb();
    const rc1 = db.prepare('SELECT report_count FROM shared_cards WHERE id = ?').get(sharedId).report_count;
    const listMid = await req('GET', '/api/character-cards/shared');
    // 再补 4 个不同用户举报 → 满 5 人下架回 pending
    for (const u of ['u2', 'u3', 'u4', 'u5']) {
      db.prepare('INSERT INTO card_reports(user_id, shared_card_id, created_at) VALUES(?,?,?)').run(u, sharedId, new Date().toISOString());
    }
    db.prepare('UPDATE shared_cards SET report_count = report_count + 4 WHERE id = ?').run(sharedId);
    const rc2 = db.prepare('SELECT report_count, status FROM shared_cards WHERE id = ?').get(sharedId);
    // 走一遍下架判断（模拟第 5 人举报触发的逻辑）
    if (rc2.report_count >= 5) db.prepare("UPDATE shared_cards SET status = 'pending' WHERE id = ?").run(sharedId);
    const list1 = await req('GET', '/api/character-cards/shared');
    const adChar = ad.json && ad.json.character;
    ok(
      '27. shared 列表可见 → 领养 201 → 点赞开/关 → 同人连点5次只记1次不下架 → 5人举报下架',
      Array.isArray(list0.json) && list0.json.length === 1 && list0.json[0].adopt_count === 0 &&
        ad.status === 201 && adChar && adChar.name === '投稿测试角' &&
        like1.json.liked === true && like1.json.like_count === 1 &&
        like2.json.liked === false && like2.json.like_count === 0 &&
        rc1 === 1 && Array.isArray(listMid.json) && listMid.json.length === 1 &&
        Array.isArray(list1.json) && list1.json.length === 0,
      `list0=${list0.json && list0.json.length} ad=${ad.status} like=${like1.json.liked}/${like2.json.liked} rc1=${rc1} mid=${listMid.json && listMid.json.length} list1=${list1.json && list1.json.length}`
    );
    if (adChar) await req('DELETE', `/api/characters/${adChar.id}`);
  }

  // 29. v1.27.1: 单聊失败重试不叠加用户消息——同内容 + regenerate 多次只保留一条
  {
    const ch = await req('POST', '/api/characters', { name: '重试测试角' });
    const c = await req('POST', `/api/characters/${ch.json.id}/conversations`, {});
    const cid = c.json.id;
    const db = getDb();
    const userCount = () =>
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'").get(cid).n;
    await postSSE(`/api/conversations/${cid}/messages`, { content: '重试去重测试' });
    const n1 = userCount();
    // 模拟"模型失败→点重试"3 次：同内容 + regenerate
    await postSSE(`/api/conversations/${cid}/messages`, { content: '重试去重测试', regenerate: true });
    await postSSE(`/api/conversations/${cid}/messages`, { content: '重试去重测试', regenerate: true });
    await postSSE(`/api/conversations/${cid}/messages`, { content: '重试去重测试', regenerate: true });
    const n2 = userCount();
    ok('29. 单聊同内容重试3次 → 用户消息仍为1条（不叠加）', n1 === 1 && n2 === 1, `n1=${n1} n2=${n2}`);
    await req('DELETE', `/api/characters/${ch.json.id}`);
  }

  // 30. v1.27.1: regenerate 但内容对不上（模拟 401/402 当时没落库）→ 当新消息正常插入
  {
    const ch = await req('POST', '/api/characters', { name: '重试测试角2' });
    const c = await req('POST', `/api/characters/${ch.json.id}/conversations`, {});
    const cid = c.json.id;
    const db = getDb();
    const userCount = () =>
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'").get(cid).n;
    await postSSE(`/api/conversations/${cid}/messages`, { content: '第一条问题' });
    // 库里最后一条是"第一条问题"，带 regenerate 发"第二条问题"→对不上→应插入
    const r = await postSSE(`/api/conversations/${cid}/messages`, { content: '第二条问题', regenerate: true });
    const n = userCount();
    const lastContent = db
      .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(cid).content;
    ok(
      '30. regenerate 内容对不上 → 正常插入新用户消息（不丢问题）',
      r.status === 200 && n === 2 && lastContent === '第二条问题',
      `status=${r.status} n=${n} last=${JSON.stringify(lastContent)}`
    );
    await req('DELETE', `/api/characters/${ch.json.id}`);
  }

  // 31. v1.27.1: 群聊失败重试不叠加用户消息
  {
    const c1 = await req('POST', '/api/characters', { name: '群重试A' });
    const c2 = await req('POST', '/api/characters', { name: '群重试B' });
    const g = await req('POST', '/api/groups', { member_ids: [c1.json.id, c2.json.id] });
    const gid = g.json.id;
    const db = getDb();
    const userCount = () =>
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'").get(gid).n;
    await postSSE(`/api/conversations/${gid}/messages`, { content: '群重试去重测试' });
    const n1 = userCount();
    await postSSE(`/api/conversations/${gid}/messages`, { content: '群重试去重测试', regenerate: true });
    await postSSE(`/api/conversations/${gid}/messages`, { content: '群重试去重测试', regenerate: true });
    const n2 = userCount();
    ok('31. 群聊同内容重试2次 → 用户消息仍为1条（不叠加）', n1 === 1 && n2 === 1, `n1=${n1} n2=${n2}`);
    await req('DELETE', `/api/conversations/${gid}`);
    for (const c of [c1, c2]) await req('DELETE', `/api/characters/${c.json.id}`);
  }

  // E1-E6. P4 发散创建（MOCK_LLM=true）
  // 前置：单用户模式管理接口被 needMulti 拦截，直接写库建测试图片模型
  {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_default,is_active,sort_order,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('prov_exptest', '探索测试供应商', 'custom', 'image', 'https://example.com/v1', '', 0, 1, 0, now);
    db.prepare(`INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('model_exptest', 'prov_exptest', 'image', 'test/explore-img', '探索测试图', '{"per_call":5}', '{"sizes":["1:1"]}', 1, 0, now);

    const FIELDS = ['silhouette','neckline','sleeve_length','sleeve_type','skirt_length','skirt_shape','waistline','fabric','primary_color','secondary_color','style','details','scene'];

    // E1. 发散：4 候选、13 字段齐全、轴上有差异、费用预估正确
    const e1 = await req('POST', '/api/studio/explore', { preset_id: 'dress', axes: ['silhouette', 'fabric'], count: 4 });
    const bid = e1.json && e1.json.id;
    const props = (e1.json && e1.json.proposals) || [];
    const fieldsOk = props.length === 4 && props.every((x) => x.dna && FIELDS.every((f) => x.dna[f] && 'value' in x.dna[f]));
    const silVals = new Set(props.map((x) => x.dna.silhouette.value));
    ok('E1. 发散创建：4 候选、13 字段齐全、发散轴有差异、预估 4×5=20',
      e1.status === 200 && bid && fieldsOk && silVals.size > 1 && e1.json.cost_estimate === 20,
      `status=${e1.status} fieldsOk=${fieldsOk} silVals=${silVals.size} estimate=${e1.json && e1.json.cost_estimate}`);

    // E2. 非法入参
    const e2a = await req('POST', '/api/studio/explore', { preset_id: 'dress', axes: ['not_a_field'], count: 4 });
    const e2b = await req('POST', '/api/studio/explore', { preset_id: 'dress', axes: ['silhouette'], count: 20 });
    const e2c = await req('POST', '/api/studio/explore', { axes: ['silhouette'], count: 4 });
    ok('E2. 非法发散轴 → 400；count=20 → 400；缺 preset_id → 400', e2a.status === 400 && e2b.status === 400 && e2c.status === 400, `a=${e2a.status} b=${e2b.status} c=${e2c.status}`);

    // E3. 文字筛选
    const e3a = await req('POST', `/api/studio/explore/${bid}/select`, { indexes: [99] });
    const e3b = await req('POST', `/api/studio/explore/${bid}/select`, { indexes: [0, 2] });
    ok('E3. 选中越界 → 400；选 [0,2] → 200',
      e3a.status === 400 && e3b.status === 200 && JSON.stringify(e3b.json.selected) === '[0,2]',
      `a=${e3a.status} b=${e3b.status}`);

    // E4. 渲染确认门 + mock 渲染
    const e4a = await req('POST', `/api/studio/explore/${bid}/render`, {});
    const e4b = await req('POST', `/api/studio/explore/${bid}/render`, { confirm: true });
    const renders = (e4b.json && e4b.json.renders) || [];
    const fs = await import('node:fs');
    const path = await import('node:path');
    const filesOk = renders.length === 2 && renders.every((r) => r.image_path && fs.existsSync(path.join(process.env.DATA_DIR, r.image_path)));
    ok('E4. 无 confirm → 400 带预估；confirm → 200，2 张渲染图落盘',
      e4a.status === 400 && e4a.json && e4a.json.cost_estimate === 20 &&
      e4b.status === 200 && filesOk,
      `a=${e4a.status} b=${e4b.status} filesOk=${filesOk}`);

    // E5. 收卡：模板 draft + 首图进 history
    const e5 = await req('POST', `/api/studio/explore/${bid}/adopt`, { indexes: [0] });
    const tid = e5.json && e5.json.template_ids && e5.json.template_ids[0];
    const tpl = tid && db.prepare('SELECT * FROM style_dna_templates WHERE id=?').get(tid);
    const gen = tid && db.prepare("SELECT * FROM dna_generations WHERE template_id=? AND op='explore'").get(tid);
    ok('E5. 收卡：模板 draft、命名发散灵感、history 有 explore 记录',
      e5.status === 200 && tpl && tpl.status === 'draft' && String(tpl.name).startsWith('发散灵感') && !!gen,
      `status=${e5.status} tpl=${tpl && tpl.status} gen=${!!gen}`);

    // E6. 归档：100 天前的批次被 runExploreArchive 归档
    const { runExploreArchive } = await import('../src/studio.js');
    db.prepare('UPDATE exploration_batches SET created_at=? WHERE id=?').run(new Date(Date.now() - 100 * 86400000).toISOString(), bid);
    const arc = runExploreArchive();
    const l1 = await req('GET', '/api/studio/explore');
    const l2 = await req('GET', '/api/studio/explore?include_archived=1');
    const inDefault = (l1.json.batches || []).some((x) => x.id === bid);
    const inArchived = (l2.json.batches || []).some((x) => x.id === bid);
    ok('E6. 归档：100 天前批次 archived，默认列表不可见、归档列表可见',
      arc.by_age >= 1 && !inDefault && inArchived,
      `by_age=${arc.by_age} inDefault=${inDefault} inArchived=${inArchived}`);

    // 清理测试数据
    db.prepare('DELETE FROM models WHERE id=?').run('model_exptest');
    db.prepare('DELETE FROM providers WHERE id=?').run('prov_exptest');
  }

  // V1-V3. 识图模型走注册表（克隆款式修复）
  {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_default,is_active,sort_order,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('prov_vtest', '视觉测试供应商', 'custom', 'llm', 'https://example.com/v1', '', 0, 1, 0, now);
    db.prepare(`INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('model_vtest', 'prov_vtest', 'chat', 'test/vision-model', '视觉测试模型',
      '{"input_per_1m":10,"output_per_1m":20}', '{"vision":true}', 1, 0, now);
    // 再建一个不支持视觉的，确保被过滤
    db.prepare(`INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('model_vtest2', 'prov_vtest', 'chat', 'test/text-model', '纯文本模型',
      '{"input_per_1m":10,"output_per_1m":20}', '{}', 1, 1, now);

    // V1. vision-models 只返回支持视觉的
    const v1 = await req('GET', '/api/studio/vision-models');
    const vmodels = (v1.json && v1.json.models) || [];
    ok('V1. vision-models 只列出勾选视觉的模型',
      v1.status === 200 && vmodels.length === 1 && vmodels[0].model_id === 'test/vision-model',
      `status=${v1.status} count=${vmodels.length}`);

    // V2. 不传 model 时自动用视觉模型（mock 下返回 mock DNA，按预设字段）
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const v2 = await req('POST', '/api/studio/dna/extract', { imageBase64: tinyPng, mimeType: 'image/png', preset_id: 'suit' });
    ok('V2. 不传模型 → 自动用视觉模型提取成功（西装 11 字段）',
      v2.status === 200 && v2.json && v2.json.dna && v2.json.dna.silhouette && v2.json.dna.lapel && v2.json.preset_id === 'suit',
      `status=${v2.status}`);

    // V2b. 不传 preset_id → 400 提示选类目
    const v2b = await req('POST', '/api/studio/dna/extract', { imageBase64: tinyPng, mimeType: 'image/png' });
    ok('V2b. 缺 preset_id → 400 提示选类目',
      v2b.status === 400 && /类目/.test(v2b.json && v2b.json.error || ''),
      `status=${v2b.status} err=${v2b.json && v2b.json.error}`);

    // V3. 删掉视觉模型后 → 400 友好提示
    db.prepare('DELETE FROM models WHERE id=?').run('model_vtest');
    const v3 = await req('POST', '/api/studio/dna/extract', { imageBase64: tinyPng, mimeType: 'image/png', preset_id: 'suit' });
    ok('V3. 无视觉模型 → 400 提示去上架',
      v3.status === 400 && /视觉/.test(v3.json && v3.json.error || ''),
      `status=${v3.status} err=${v3.json && v3.json.error}`);

    db.prepare('DELETE FROM models WHERE id=?').run('model_vtest2');
    db.prepare('DELETE FROM providers WHERE id=?').run('prov_vtest');
  }

  // P1-P3. P5 DNA 类目预设
  {
    // P1. 公开列表：9 个预设，西装 11 字段、连衣裙 13 字段
    const p1 = await req('GET', '/api/studio/dna-presets');
    const ps = (p1.json && p1.json.presets) || [];
    const suit = ps.find((x) => x.id === 'suit');
    const dress = ps.find((x) => x.id === 'dress');
    ok('P1. 预设列表：9 个类目，西装 11 字段、连衣裙 13 字段',
      p1.status === 200 && ps.length === 9 && (suit.fields || []).length === 11 && (dress.fields || []).length === 13,
      `status=${p1.status} count=${ps.length}`);

    // P2. 模板创建带 preset_id，详情能读回
    const tp = await req('POST', '/api/studio/templates', {
      name: '预设测试模板', preset_id: 'pants', category: 'pants',
      dna_json: { silhouette: { value: '直筒', confidence: 0.9 } },
    });
    const tid = tp.json && tp.json.id;
    const tg = tid && await req('GET', `/api/studio/templates/${tid}`);
    ok('P2. 模板 preset_id 存取',
      tp.status === 200 && tg.json && tg.json.template.preset_id === 'pants',
      `create=${tp.status} preset=${tg.json && tg.json.template.preset_id}`);
    if (tid) { const { getDb } = await import('../src/db.js'); getDb().prepare('DELETE FROM style_dna_templates WHERE id=?').run(tid); }

    // P3. 发散收卡带 preset_id（E6 已清理测试模型，这里重建）
    {
      const { getDb: getDbP3a } = await import('../src/db.js');
      const dbP3 = getDbP3a();
      const nowP3 = new Date().toISOString();
      dbP3.prepare(`INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_default,is_active,sort_order,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run('prov_p3test', 'P3测试供应商', 'custom', 'image', 'https://example.com/v1', '', 0, 1, 0, nowP3);
      dbP3.prepare(`INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run('model_p3test', 'prov_p3test', 'image', 'test/p3-img', 'P3测试图', '{"per_call":5}', '{"sizes":["1:1"]}', 1, 0, nowP3);
    }
    const p3 = await req('POST', '/api/studio/explore', { preset_id: 'pants', axes: ['silhouette'], count: 2 });
    const pbid = p3.json && p3.json.id;
    const pa = pbid ? await req('POST', `/api/studio/explore/${pbid}/adopt`, { indexes: [0] }) : null;
    const ptid = pa && pa.json && pa.json.template_ids && pa.json.template_ids[0];
    const { getDb: getDbP3 } = await import('../src/db.js');
    const ptpl = ptid && getDbP3().prepare('SELECT preset_id FROM style_dna_templates WHERE id=?').get(ptid);
    ok('P3. 发散收卡带 preset_id',
      p3.status === 200 && pa && pa.status === 200 && ptpl && ptpl.preset_id === 'pants',
      `explore=${p3.status} adopt=${pa && pa.status} preset=${ptpl && ptpl.preset_id}`);
    // 清理 P3 测试数据
    {
      const { getDb: getDbP3b } = await import('../src/db.js');
      const dbP3b = getDbP3b();
      if (ptid) dbP3b.prepare('DELETE FROM style_dna_templates WHERE id=?').run(ptid);
      dbP3b.prepare('DELETE FROM models WHERE id=?').run('model_p3test');
      dbP3b.prepare('DELETE FROM providers WHERE id=?').run('prov_p3test');
    }
  }

  // P6. 服务端兜底压缩：小图原样返回，大图压到 1024px 内
  {
    const { shrinkImageIfLarge } = await import('../src/studio.js');
    const sharp = (await import('sharp')).default;
    // 造一张 2000x2000 的随机噪声大图（base64 必超 2MB）
    const { randomBytes } = await import('node:crypto');
    const noise = randomBytes(2000 * 2000 * 3);
    const bigBuf = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } }).png().toBuffer();
    const bigB64 = bigBuf.toString('base64');
    const smallB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const rSmall = await shrinkImageIfLarge(smallB64, 'image/png');
    const rBig = await shrinkImageIfLarge(bigB64, 'image/png');
    const bigMeta = await sharp(Buffer.from(rBig.base64, 'base64')).metadata();
    ok('P6. 小图原样返回；大图压到最长边≤1024 且转 JPEG',
      rSmall.base64 === smallB64 && rSmall.mimeType === 'image/png' &&
      rBig.mimeType === 'image/jpeg' && Math.max(bigMeta.width, bigMeta.height) <= 1024 &&
      rBig.base64.length < bigB64.length,
      `small=${rSmall.base64 === smallB64} big=${bigMeta.width}x${bigMeta.height} mime=${rBig.mimeType}`);
  }
  // P7. 模板保存时来源图缩略图落盘且入库
  {
    const sharp7 = (await import('sharp')).default;
    const tinyJpg = await sharp7({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const tp7 = await req('POST', '/api/studio/templates', {
      name: 'P7缩略图测试', preset_id: 'shirt',
      dna_json: { silhouette: { value: '常规', confidence: 0.9 } },
      source_image_base64: tinyJpg.toString('base64'),
    });
    const tid7 = tp7.json && tp7.json.id;
    const { getDb: getDbP7 } = await import('../src/db.js');
    const row7 = tid7 && getDbP7().prepare('SELECT source_image_path, source_thumb_path FROM style_dna_templates WHERE id=?').get(tid7);
    const fsP7 = await import('node:fs');
    const pathP7 = await import('node:path');
    const thumbExists = row7 && row7.source_thumb_path && fsP7.existsSync(pathP7.join(process.env.DATA_DIR, row7.source_thumb_path));
    ok('P7. 来源图缩略图入库且文件存在',
      tp7.status === 200 && !!row7.source_thumb_path && thumbExists,
      `create=${tp7.status} thumb=${row7 && row7.source_thumb_path} exists=${thumbExists}`);
    if (tid7) {
      const dbP7 = getDbP7();
      const r7 = dbP7.prepare('SELECT source_image_path, source_thumb_path FROM style_dna_templates WHERE id=?').get(tid7);
      for (const fp of [r7.source_image_path, r7.source_thumb_path]) {
        try { const a = pathP7.join(process.env.DATA_DIR, fp); if (fp && fsP7.existsSync(a)) fsP7.unlinkSync(a); } catch {}
      }
      dbP7.prepare('DELETE FROM style_dna_templates WHERE id=?').run(tid7);
    }
  }
}
