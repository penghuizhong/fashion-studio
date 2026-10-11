import { ok, req, postSSE, makeJar, parseSSE, base, getDb, getConfig, estimateTokens, summarizeOld, runMemoryPipeline, retrieveFacts, llmCreds, encryptSecret, decryptSecret } from './check-lib.js';

export async function runMulti() {
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

  // M14. 积分：注册奖励改首聊发放 → 新用户余额 0；默认 points 模式，白名单 3 模型（v1.26.3 起移除硬编码 RP 模型种子）
  {
    const p = await req('GET', '/api/points', undefined, { jar: jarB });
    const ids = Array.isArray(p.json.models) ? p.json.models.map((m) => m.id) : [];
    ok(
      'M14. GET /api/points → balance 0（奖励首聊发）/ billing_mode=points / 3 个白名单模型',
      p.status === 200 && p.json && p.json.balance === 0 &&
        p.json.billing_mode === 'points' &&
        Array.isArray(p.json.models) && p.json.models.length === 3 &&
        ids.includes('qwen/qwen3.8-flash') && ids.includes('google/gemini-3.8-flash') && ids.includes('openai/gpt-6-luna'),
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
    // M27. 注册奖励首聊发放：B（已获 grant 100，未领注册奖励）聊一条 → +100（v1.18.1 默认），账本有 signup_bonus
    const chB = await req('POST', '/api/characters', { name: '小测' }, { jar: jarB2 });
    const charB2 = chB.json && chB.json.id;
    const cvB = await req('POST', `/api/characters/${charB2}/conversations`, {}, { jar: jarB2 });
    const convB = cvB.json && cvB.json.id;
    await postSSE(`/api/conversations/${convB}/messages`, { content: '你好' }, { jar: jarB2 });
    const pb = await req('GET', '/api/points', undefined, { jar: jarB2 });
    const lb = await req('GET', '/api/points/ledger?limit=5', undefined, { jar: jarB2 });
    const reasonsB = Array.isArray(lb.json) ? lb.json.map((x) => x.reason) : [];
    ok(
      'M27. 首聊后注册奖励到账：B 余额 100+100=200，账本有 signup_bonus',
      pb.json && pb.json.balance === 200 && reasonsB.includes('signup_bonus'),
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

  // M33. 敏感词投稿 → 400；同一用户重复举报只记1次；5个不同用户举报 → 下架回 pending（v1.28.1 去重）
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
    // 用户 B 连点 2 次 → 只记 1 次
    const rp1 = await req('POST', `/api/character-cards/shared/${sid}/report`, { reason: '测试' }, { jar: jarB2b });
    const rp2 = await req('POST', `/api/character-cards/shared/${sid}/report`, { reason: '测试' }, { jar: jarB2b });
    const db = getDb();
    const rc1 = db.prepare('SELECT report_count FROM shared_cards WHERE id = ?').get(sid).report_count;
    // 再注册 4 个用户各举报 1 次 → 满 5 人触发下架
    for (const u of ['rpt1', 'rpt2', 'rpt3', 'rpt4']) {
      const jar = makeJar();
      await req('POST', '/api/auth/register', { username: u, password: 'password123' }, { jar });
      await req('POST', `/api/character-cards/shared/${sid}/report`, { reason: '测试' }, { jar });
    }
    const list = await req('GET', '/api/character-cards/shared');
    const pend = await req('GET', '/api/admin/shared-cards?status=pending', undefined, { jar: jarAdminM });
    ok(
      'M33. 敏感词投稿 → 400；同人连点只记1次；5个不同用户举报 → 广场列表消失且回待审队列',
      bad.status === 400 && /敏感词/.test(bad.json.error || '') &&
        pub.status === 201 &&
        rp1.status === 200 && /已收到/.test(rp1.json.message || '') &&
        /已经举报过/.test(rp2.json.message || '') && rc1 === 1 &&
        Array.isArray(list.json) && !list.json.some((x) => x.id === sid) &&
        pend.json.some((x) => x.id === sid),
      `bad=${bad.status} rp2msg=${rp2.json.message} rc1=${rc1} list=${list.json && list.json.length} backToPending=${pend.json.some((x) => x.id === sid)}`
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

  // M36. v1.11 记忆事实：B 看不到/删不掉 A 的 fact
  {
    const db = getDb();
    const ins = db.prepare('INSERT INTO memory_facts(character_id, fact, importance, created_at, source) VALUES(?,?,?,?,?)').run(
      charA, 'M36 隔离测试事实', 3, new Date().toISOString(), 'test'
    );
    const fid = Number(ins.lastInsertRowid);
    // jarA 在 M12 已登出、testuserB 在 M23 改过密码，这里用新会话登录
    const jarA36 = makeJar();
    const jarB36 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA36 });
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB36 });
    const bList = await req('GET', `/api/characters/${charA}/facts`, undefined, { jar: jarB36 });
    const bDel = await req('DELETE', `/api/facts/${fid}`, undefined, { jar: jarB36 });
    const aList = await req('GET', `/api/characters/${charA}/facts`, undefined, { jar: jarA36 });
    const aHas = (Array.isArray(aList.json) ? aList.json : []).some((f) => f.id === fid);
    const aDel = await req('DELETE', `/api/facts/${fid}`, undefined, { jar: jarA36 });
    ok(
      'M36. B 读 A 的 facts → 404；B 删 A 的 fact → 404；A 自己可读可删',
      bList.status === 404 && bDel.status === 404 && aList.status === 200 && aHas && aDel.status === 200,
      `bList=${bList.status} bDel=${bDel.status} aHas=${aHas} aDel=${aDel.status}`
    );
  }

  // M37. v1.12 管理员模型配置：读写 + 校验 + 非管理员 403
  {
    const jarA37 = makeJar();
    const jarB37 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA37 });
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB37 });
    const g0 = await req('GET', '/api/admin/settings', undefined, { jar: jarA37 });
    const badModel = await req('PUT', '/api/admin/settings', { worker_model: 'no-such-model' }, { jar: jarA37 });
    const forbidden = await req('PUT', '/api/admin/settings', { worker_model: 'qwen/qwen3.8-flash' }, { jar: jarB37 });
    const set1 = await req('PUT', '/api/admin/settings', { worker_model: 'qwen/qwen3.8-flash', chat_default_model: '' }, { jar: jarA37 });
    const g1 = await req('GET', '/api/admin/settings', undefined, { jar: jarA37 });
    // getWorkerModel 应返回管理员配置的模型
    const { getWorkerModel } = await import('../src/points.js');
    const wm = getWorkerModel();
    // 清理：恢复自动
    await req('PUT', '/api/admin/settings', { worker_model: '', chat_default_model: '' }, { jar: jarA37 });
    // v1.15.1 诊断：CI 偶发 set=400 时打出表内容（含不可见字符）
    const { getDb: getDb37 } = await import('../src/db.js');
    const models37 = getDb37().prepare('SELECT model_id, is_active FROM points_models').all();
    const modelsStr = JSON.stringify(models37.map((r) => [r.model_id, r.is_active]));
    ok(
      'M37. 管理员读写模型配置；非法模型 → 400；非管理员 → 403；getWorkerModel 生效',
      g0.status === 200 && 'worker_model' in (g0.json || {}) &&
        badModel.status === 400 && forbidden.status === 403 &&
        set1.status === 200 && g1.json.worker_model === 'qwen/qwen3.8-flash' && wm === 'qwen/qwen3.8-flash',
      `get=${g0.status} bad=${badModel.status} forbid=${forbidden.status} set=${set1.status} wm=${wm} models=${modelsStr} setBody=${JSON.stringify(set1.json)}`
    );
  }

  // M41. v1.17.0 破限预设插件化：列表/角色选用/非法 key 清洗/模型匹配
  {
    const jarA41 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA41 });
    const presets = await req('GET', '/api/jailbreak-presets', undefined, { jar: jarA41 });
    const keys = presets.status === 200 ? (presets.json.presets || []).map((p) => p.key) : [];
    // 角色启用破限
    const setJb = await req('PUT', `/api/characters/${charA}`, { jailbreak_preset: 'deepseek-rp-light' }, { jar: jarA41 });
    const got = await req('GET', `/api/characters/${charA}`, undefined, { jar: jarA41 });
    // 非法 key 被清洗为 null
    const setBad = await req('PUT', `/api/characters/${charA}`, { jailbreak_preset: 'no-such-preset' }, { jar: jarA41 });
    const got2 = await req('GET', `/api/characters/${charA}`, undefined, { jar: jarA41 });
    // 注入逻辑（v1.17.12 起与模型解耦）：选用即注入、未启用不注入
    const { jailbreakPromptOf } = await import('../src/jailbreakPresets.js');
    const jbOnMatch = jailbreakPromptOf({ jailbreak_preset: 'deepseek-rp-light' }, 'deepseek/deepseek-v3.2');
    const jbOnMismatch = jailbreakPromptOf({ jailbreak_preset: 'deepseek-rp-light' }, 'sao10k/l3.3-euryale-70b');
    const jbOff = jailbreakPromptOf({ jailbreak_preset: null }, 'deepseek/deepseek-v3.2');
    // 恢复关闭
    await req('PUT', `/api/characters/${charA}`, { jailbreak_preset: null }, { jar: jarA41 });
    ok(
      'M41. 破限预设：列表/选用/非法key清洗/选中即注入',
      presets.status === 200 && keys.includes('deepseek-rp-light') &&
        setJb.status === 200 && (got.json.jailbreak_preset === 'deepseek-rp-light') &&
        (got2.json.jailbreak_preset === null || got2.json.jailbreak_preset === undefined) &&
        jbOnMatch.length > 0 && jbOnMismatch.length > 0 && jbOff === '',
      `presets=${presets.status} keys=${keys.join(',')} set=${setJb.status} got=${got.json.jailbreak_preset} bad=${got2.json.jailbreak_preset}`
    );
  }

  // M42. v1.17.1 finish_reason 捕获：content_filter 半截流被识别
  {
    const http = await import('node:http');
    // 重新导入 llm.js 以绕过已构建的代理 dispatcher（直连本地伪造 SSE 服务器）
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
    const { chatStream } = await import(`../src/llm.js?m42=${Date.now()}`);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"半截话"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const oldMock = process.env.MOCK_LLM;
    process.env.MOCK_LLM = '';
    let got = '';
    let r;
    try {
      r = await chatStream({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'test/model',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
        onToken: (d) => { got += d; },
      });
    } finally {
      process.env.MOCK_LLM = oldMock;
      server.close();
    }
    ok(
      'M42. chatStream 捕获 finish_reason=content_filter',
      r && r.finishReason === 'content_filter' && got === '半截话',
      `finishReason=${r && r.finishReason} text=${got}`
    );
  }

  // M43. v1.17.2 429 自动重试 + 友好错误文案
  {
    const { withRetry, friendlyLlmError } = await import('../src/llm.js');
    let calls2 = 0;
    const flaky2 = async () => {
      calls2++;
      if (calls2 < 3) {
        const e = new Error('x');
        e.status = 429;
        throw e;
      }
      return 'ok2';
    };
    const r2 = await withRetry(flaky2, { retries: 3, baseMs: 10 });
    const always429 = async () => {
      const e = new Error('x');
      e.status = 429;
      throw e;
    };
    let threw = null;
    try {
      await withRetry(always429, { retries: 1, baseMs: 10 });
    } catch (e) {
      threw = e;
    }
    const e429 = new Error('x'); e429.status = 429;
    const e500 = new Error('x'); e500.status = 500;
    const eOther = new Error('raw json here');
    ok(
      'M43. withRetry 429 重试后成功/耗尽抛出/friendlyLlmError 映射',
      r2 === 'ok2' && calls2 === 3 &&
        threw && threw.status === 429 &&
        friendlyLlmError(e429) === '上游限流了，休息几秒再试一次' &&
        friendlyLlmError(e500) === '上游服务暂时不可用，稍后再试' &&
        friendlyLlmError(eOther) === '生成失败，换句话试试' &&
        !friendlyLlmError(eOther).includes('raw json'),
      `r2=${r2} calls2=${calls2} threw=${!!threw}`
    );
  }

  // M44. v1.17.3 回退链可配置 + 单聊账本记实际模型
  // v1.26.3: 改用实际种子的模型（qwen/gemini/gpt），不再依赖已删除的硬编码 RP 模型
  {
    const { getFilterFallbackModels, pickFilterFallbackModel } = await import('../src/app.js');
    const db = getDb();
    db.prepare("DELETE FROM sys_settings WHERE key = 'filter_fallback_models'").run();

    // 1. 默认链（v1.26.3 起默认链仍为 euryale→cydonia，但测试用实际存在的模型）
    const def = getFilterFallbackModels();
    // 默认链定义不变，但测试时我们用实际存在的模型来验证逻辑
    const testChain = ['qwen/qwen3.8-flash', 'google/gemini-3.8-flash'];
    const put0 = await req('PUT', '/api/admin/settings', { filter_fallback_models: testChain }, { jar: jarAdminM });
    const custom0 = getFilterFallbackModels();
    const defOk = put0.status === 200 && JSON.stringify(custom0) === JSON.stringify(testChain);

    // 2. 管理员自定义顺序（PUT/GET /api/admin/settings）
    const put1 = await req('PUT', '/api/admin/settings', { filter_fallback_models: ['google/gemini-3.8-flash', 'openai/gpt-6-luna'] }, { jar: jarAdminM });
    const get1 = await req('GET', '/api/admin/settings', undefined, { jar: jarAdminM });
    const custom = getFilterFallbackModels();
    const pickA = pickFilterFallbackModel('openai/gpt-6-luna'); // 当前 gpt → 链首 gemini
    const pickB = pickFilterFallbackModel('google/gemini-3.8-flash'); // 当前 gemini → 跳过，取 gpt

    // 3. 非法模型拒绝
    const bad = await req('PUT', '/api/admin/settings', { filter_fallback_models: ['no/such-model'] }, { jar: jarAdminM });

    // 4. 显式 [] = 关闭回退
    const putEmpty = await req('PUT', '/api/admin/settings', { filter_fallback_models: [] }, { jar: jarAdminM });
    const pickNone = pickFilterFallbackModel('openai/gpt-6-luna');

    // 5. 恢复默认
    db.prepare("DELETE FROM sys_settings WHERE key = 'filter_fallback_models'").run();
    const def2 = getFilterFallbackModels();

    // 6. 端到端：伪造上游（首次 content_filter，第二次正常），验证账本记回退后模型
    // 删代理 + resetDispatcher()，让 llm 直连本地伪造服务器
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
    const { resetDispatcher } = await import('../src/llm.js');
    resetDispatcher();
    const http = await import('node:http');
    let n = 0;
    const fake = http.createServer((rq, rs) => {
      n++;
      rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (n === 1) {
        rs.write('data: {"choices":[{"delta":{"content":"半截"},"finish_reason":null}]}\n\n');
        rs.write('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n');
      } else {
        rs.write('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n');
        rs.write('data: {"choices":[{"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":10,"output_tokens":5}}]}\n\n');
      }
      rs.write('data: [DONE]\n\n');
      rs.end();
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    const oldBase = process.env.OPENROUTER_BASE_URL;
    const oldKey = process.env.OPENROUTER_API_KEY;
    const oldMock = process.env.MOCK_LLM;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.MOCK_LLM = '';
    let e2eModel = null; let e2eFilterRetry = false;
    try {
      // 先设置回退链为测试用的模型
      await req('PUT', '/api/admin/settings', { filter_fallback_models: ['qwen/qwen3.8-flash', 'google/gemini-3.8-flash'] }, { jar: jarAdminM });
      const chR = await req('POST', '/api/characters', { name: 'M44角色' }, { jar: jarAdminM });
      const chId = chR.json && chR.json.id;
      const cvR = await req('POST', `/api/characters/${chId}/conversations`, {}, { jar: jarAdminM });
      const cvId = cvR.json && cvR.json.id;
      const ck = jarAdminM.header();
      const sseRes = await fetch(base + `/api/conversations/${cvId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-model': 'openai/gpt-6-luna', ...(ck ? { Cookie: ck } : {}) },
        body: JSON.stringify({ content: 'hi' }),
      });
      const text = await sseRes.text();
      e2eFilterRetry = text.includes('filter_retry');
      const row = db.prepare("SELECT model FROM points_ledger WHERE user_id = (SELECT id FROM users WHERE username = 'testuserA') AND reason = 'chat' ORDER BY id DESC LIMIT 1").get();
      e2eModel = row && row.model;
    } finally {
      if (oldBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = oldBase;
      if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
      process.env.MOCK_LLM = oldMock;
      fake.close();
    }
    ok(
      'M44. 回退链可配置/非法拒绝/[]关闭/默认恢复/账本记回退模型',
      defOk &&
        put1.status === 200 &&
        JSON.stringify(get1.json.filter_fallback_models) === JSON.stringify(['google/gemini-3.8-flash', 'openai/gpt-6-luna']) &&
        JSON.stringify(custom) === JSON.stringify(['google/gemini-3.8-flash', 'openai/gpt-6-luna']) &&
        pickA === 'google/gemini-3.8-flash' &&
        pickB === 'openai/gpt-6-luna' &&
        bad.status === 400 &&
        putEmpty.status === 200 && pickNone === null &&
        e2eFilterRetry && e2eModel === 'qwen/qwen3.8-flash',
      `def=${JSON.stringify(def)} pickA=${pickA} pickB=${pickB} pickNone=${pickNone} e2eModel=${e2eModel} filterRetry=${e2eFilterRetry}`
    );
  }

  // M45. v1.17.4 SSE 心跳：上游慢响应期间客户端能收到 : ping（防 idle 断连）
  {
    const http = await import('node:http');
    const { resetDispatcher } = await import('../src/llm.js');
    resetDispatcher();
    // 伪造上游：首字节延迟 400ms，模拟慢模型
    const fake = http.createServer((rq, rs) => {
      rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
      setTimeout(() => {
        rs.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        rs.write('data: {"choices":[{"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":5,"output_tokens":2}}]}\n\n');
        rs.write('data: [DONE]\n\n');
        rs.end();
      }, 400);
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    const oldBase = process.env.OPENROUTER_BASE_URL;
    const oldKey = process.env.OPENROUTER_API_KEY;
    const oldMock = process.env.MOCK_LLM;
    const oldKa = process.env.SSE_KEEPALIVE_MS;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.MOCK_LLM = '';
    process.env.SSE_KEEPALIVE_MS = '100';
    let sawPing = false;
    try {
      const chR = await req('POST', '/api/characters', { name: 'M45角色' }, { jar: jarAdminM });
      const chId = chR.json && chR.json.id;
      const cvR = await req('POST', `/api/characters/${chId}/conversations`, {}, { jar: jarAdminM });
      const cvId = cvR.json && cvR.json.id;
      const ck = jarAdminM.header();
      const sseRes = await fetch(base + `/api/conversations/${cvId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-model': 'deepseek/deepseek-v3.2', ...(ck ? { Cookie: ck } : {}) },
        body: JSON.stringify({ content: 'hi' }),
      });
      const text = await sseRes.text();
      sawPing = text.includes(': ping');
    } finally {
      if (oldBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = oldBase;
      if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
      process.env.MOCK_LLM = oldMock;
      if (oldKa === undefined) delete process.env.SSE_KEEPALIVE_MS; else process.env.SSE_KEEPALIVE_MS = oldKa;
      fake.close();
    }
    ok(
      'M45. SSE 心跳：慢上游期间收到 : ping',
      sawPing,
      `sawPing=${sawPing}`
    );
  }

  // M46. v1.17.5 系统提示词模板可配置（扮演默认 + 破限预设覆盖）
  {
    const { getRoleplayTemplate, roleplayPromptOf } = await import('../src/memory.js');
    const { jailbreakPresetPrompt, jailbreakPromptOf, jailbreakPresetAdminList } = await import('../src/jailbreakPresets.js');
    const db = getDb();
    db.prepare("DELETE FROM sys_settings WHERE key IN ('roleplay_template','jailbreak_presets_override')").run();

    // 1. 默认：内置模板
    const defRp = getRoleplayTemplate();
    const defJb = jailbreakPresetPrompt('deepseek-rp-light');
    const charOn = { roleplay_mode: 1, roleplay_prompt: '', jailbreak_preset: 'deepseek-rp-light' };
    const effRp0 = roleplayPromptOf(charOn);
    const effJb0 = jailbreakPromptOf(charOn, 'deepseek/deepseek-v3.2');
    const effJbMismatch = jailbreakPromptOf(charOn, 'sao10k/l3.3-euryale-70b'); // v1.17.12: 预设与模型解耦，任何模型都注入

    // 2. 管理员覆盖（经 API）
    const put1 = await req('PUT', '/api/admin/settings', {
      roleplay_template: '自定义扮演模板A',
      jailbreak_presets: { 'deepseek-rp-light': '自定义破限B' },
    }, { jar: jarAdminM });
    const get1 = await req('GET', '/api/admin/settings', undefined, { jar: jarAdminM });
    const effRp1 = roleplayPromptOf(charOn);
    const effJb1 = jailbreakPromptOf(charOn, 'deepseek/deepseek-v3.2');
    const charCustom = { roleplay_mode: 1, roleplay_prompt: '角色自定义', jailbreak_preset: 'deepseek-rp-light' };
    const effRpChar = roleplayPromptOf(charCustom); // 角色自定义优先于系统模板
    const adminList = jailbreakPresetAdminList();

    // 3. 非管理员拒绝（用新会话登录 testuserB，密码已被 M32 改为 newpassword123）
    const jarB46 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB46 });
    const forbidden = await req('PUT', '/api/admin/settings', { roleplay_template: 'x' }, { jar: jarB46 });

    // 4. 清空恢复内置
    const put2 = await req('PUT', '/api/admin/settings', {
      roleplay_template: '',
      jailbreak_presets: { 'deepseek-rp-light': '' },
    }, { jar: jarAdminM });
    const effRp2 = roleplayPromptOf(charOn);
    const effJb2 = jailbreakPromptOf(charOn, 'deepseek/deepseek-v3.2');

    // 5. 清理
    db.prepare("DELETE FROM sys_settings WHERE key IN ('roleplay_template','jailbreak_presets_override')").run();

    ok(
      'M46. 提示词模板：默认/覆盖/角色优先/鉴权/清空恢复',
      defRp.length > 50 && defJb.includes('虚构') &&
        effRp0 === defRp && effJb0 === defJb && effJbMismatch === defJb &&
        put1.status === 200 &&
        get1.json.roleplay_template === '自定义扮演模板A' &&
        get1.json.roleplay_template_custom === true &&
        get1.json.jailbreak_presets.some((p) => p.key === 'deepseek-rp-light' && p.custom && p.prompt === '自定义破限B') &&
        effRp1 === '自定义扮演模板A' && effJb1 === '自定义破限B' &&
        effRpChar === '角色自定义' &&
        adminList.some((p) => p.key === 'deepseek-rp-light' && p.custom) &&
        forbidden.status === 403 &&
        put2.status === 200 && effRp2 === defRp && effJb2 === defJb,
      `put1=${put1.status} effRp1=${effRp1.slice(0, 8)} effJb1=${effJb1.slice(0, 6)} forbidden=${forbidden.status}`
    );
  }

  // M47. v1.17.7 生效模板公开接口 /api/prompt-templates（一键填入/恢复默认吃这个）
  {
    const { getRoleplayTemplate } = await import('../src/memory.js');
    const db = getDb();
    db.prepare("DELETE FROM sys_settings WHERE key='roleplay_template'").run();

    // 1. 默认：返回内置模板（未登录也可读）
    const t0 = await req('GET', '/api/prompt-templates');
    let t1, t2;
    // 2. 管理员覆盖后：返回覆盖后的
    const put1 = await req('PUT', '/api/admin/settings', { roleplay_template: '覆盖模板C' }, { jar: jarAdminM });
    t1 = await req('GET', '/api/prompt-templates');
    // 3. 清空恢复内置
    const put2 = await req('PUT', '/api/admin/settings', { roleplay_template: '' }, { jar: jarAdminM });
    t2 = await req('GET', '/api/prompt-templates');
    db.prepare("DELETE FROM sys_settings WHERE key='roleplay_template'").run();

    ok(
      'M47. 提示词模板公开接口：默认/覆盖/清空恢复',
      t0.status === 200 && t0.json.roleplay_template === getRoleplayTemplate() && t0.json.roleplay_template.length > 50 &&
        put1.status === 200 && t1.json.roleplay_template === '覆盖模板C' &&
        put2.status === 200 && t2.json.roleplay_template === getRoleplayTemplate(),
      `t0=${t0.status} t1=${t1.json.roleplay_template.slice(0, 6)} t2len=${t2.json.roleplay_template.length}`
    );
  }

  // M48. v1.17.10 上游请求带 reasoning:{enabled:false}（关 thinking，省 token/首字更快）
  {
    const { resetDispatcher } = await import('../src/llm.js');
    resetDispatcher();
    const http = await import('node:http');
    let gotBody = null;
    const fake = http.createServer((rq, rs) => {
      let buf = '';
      rq.on('data', (c) => { buf += c; });
      rq.on('end', () => {
        try { gotBody = JSON.parse(buf); } catch { gotBody = null; }
        rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
        rs.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop","usage":{"prompt_tokens":10,"output_tokens":5}}]}\n\n');
        rs.write('data: [DONE]\n\n');
        rs.end();
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    const oldBase = process.env.OPENROUTER_BASE_URL;
    const oldKey = process.env.OPENROUTER_API_KEY;
    const oldMock = process.env.MOCK_LLM;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENROUTER_API_KEY = 'sk-test-123';
    process.env.MOCK_LLM = '';
    try {
      const chR = await req('POST', '/api/characters', { name: 'M48角色' }, { jar: jarAdminM });
      const chId = chR.json && chR.json.id;
      const cvR = await req('POST', `/api/characters/${chId}/conversations`, {}, { jar: jarAdminM });
      const cvId = cvR.json && cvR.json.id;
      const ck = jarAdminM.header();
      const sseRes = await fetch(base + `/api/conversations/${cvId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-model': 'qwen/qwen3.7-plus', ...(ck ? { Cookie: ck } : {}) },
        body: JSON.stringify({ content: 'hi' }),
      });
      await sseRes.text();
    } finally {
      if (oldBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = oldBase;
      if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
      process.env.MOCK_LLM = oldMock;
      fake.close();
    }
    const reasoningOff = gotBody && gotBody.reasoning && gotBody.reasoning.enabled === false;
    ok(
      'M48. 上游请求带 reasoning:{enabled:false}',
      reasoningOff === true,
      `reasoning=${JSON.stringify(gotBody && gotBody.reasoning)}`
    );
  }

  // M49. v1.17.11 Qwen 专用破限预设（deepseek-rp-light 保持原提示词）
  // v1.17.12: 预设与模型解耦——选中即注入，不限聊天模型
  {
    const { JAILBREAK_PRESETS, jailbreakPresetList, jailbreakPresetPrompt, jailbreakPromptOf, jailbreakPresetAdminList } =
      await import('../src/jailbreakPresets.js');
    const list = jailbreakPresetList();
    const adminList = jailbreakPresetAdminList();
    const qwenPrompt = jailbreakPresetPrompt('qwen-rp');
    const dsPrompt = jailbreakPresetPrompt('deepseek-rp-light');
    const charQwen = { roleplay_mode: 0, roleplay_prompt: '', jailbreak_preset: 'qwen-rp' };
    const charDs = { roleplay_mode: 0, roleplay_prompt: '', jailbreak_preset: 'deepseek-rp-light' };
    ok(
      'M49. 破限预设：DeepSeek 原词保留/Qwen 新预设/选中即注入',
      list.length === 2 &&
        list.some((p) => p.key === 'deepseek-rp-light') &&
        list.some((p) => p.key === 'qwen-rp') &&
        dsPrompt.includes('不拒绝、不说教') && // DeepSeek 用回之前那个提示词
        qwenPrompt.includes('虚构文学创作') &&
        qwenPrompt.includes('角色锁定') &&
        jailbreakPromptOf(charQwen, 'qwen/qwen3.7-plus') === qwenPrompt &&
        jailbreakPromptOf(charQwen, 'deepseek/deepseek-v3.2') === qwenPrompt && // 不限模型：选 Qwen 就注 Qwen
        jailbreakPromptOf(charDs, 'deepseek/deepseek-v3.2') === dsPrompt &&
        jailbreakPromptOf(charDs, 'qwen/qwen3.7-plus') === dsPrompt && // 选 DeepSeek 就注 DeepSeek
        jailbreakPromptOf({ jailbreak_preset: null }, 'qwen/qwen3.7-plus') === '' && // 未选用不注入
        adminList.some((p) => p.key === 'qwen-rp' && (p.models || []).includes('qwen/qwen3.7-plus')),
      `presets=${list.map((p) => p.key).join(',')}`
    );
  }

  // M50. v1.18.0 对话标题 A+B：问候开场留占位；有意义首句截 18 字；PUT 改名；第二轮不覆盖自定义名
  {
    const jarT = makeJar(); // 独立用户（jarA 在前面的登出测试里已失效）
    await req('POST', '/api/auth/register', { username: 'm50user', password: 'password123' }, { jar: jarT });
    const chR = await req('POST', '/api/characters', { name: 'M50标题角色' }, { jar: jarT });
    const chId = chR.json.id;
    // 问候开场 → 标题留"新对话"占位（不等 AI，mock 下跳过 AI）
    const c1 = await req('POST', `/api/characters/${chId}/conversations`, {}, { jar: jarT });
    const s1 = await postSSE(`/api/conversations/${c1.json.id}/messages`, { content: '你好' }, { jar: jarT });
    const done1 = s1.events.find((e) => e.event === 'done');
    // 有意义首句 → 规则标题截 18 字
    const c2 = await req('POST', `/api/characters/${chId}/conversations`, {}, { jar: jarT });
    const msg2 = '今天天气真不错我们去公园散步吧然后晚上一起去吃火锅怎么样';
    const s2 = await postSSE(`/api/conversations/${c2.json.id}/messages`, { content: msg2 }, { jar: jarT });
    const done2 = s2.events.find((e) => e.event === 'done');
    // 改名接口
    const rn = await req('PUT', `/api/conversations/${c2.json.id}`, { title: '我的自定义名' }, { jar: jarT });
    // 第二轮不覆盖自定义名
    const s3 = await postSSE(`/api/conversations/${c2.json.id}/messages`, { content: '再聊一句' }, { jar: jarT });
    const done3 = s3.events.find((e) => e.event === 'done');
    ok(
      'M50. 标题：问候留占位/有意义截18字/改名生效/第二轮不覆盖',
      done1 && done1.data.title === '新对话' &&
        done2 && done2.data.title === msg2.slice(0, 18) &&
        rn.status === 200 && rn.json.title === '我的自定义名' &&
        done3 && done3.data.title === '我的自定义名',
      `t1=${done1 && done1.data.title} t2=${done2 && done2.data.title} t3=${done3 && done3.data.title} rn=${rn.status}`
    );
  }

  // M50b. v1.18.0 genTitle：去引号、截断（fake 上游）
  {
    const http = await import('node:http');
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
    const { genTitle } = await import(`../src/llm.js?m50=${Date.now()}`);
    const fake = http.createServer((rq, rs) => {
      let buf = '';
      rq.on('data', (c) => { buf += c; });
      rq.on('end', () => {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ choices: [{ message: { content: '「公园散步计划」' } }] }));
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    const oldMock = process.env.MOCK_LLM;
    process.env.MOCK_LLM = '';
    let title = '';
    try {
      title = await genTitle({ userText: '去公园', asstText: '好啊', model: 'test/m', apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${port}` });
    } finally {
      process.env.MOCK_LLM = oldMock;
      fake.close();
    }
    ok('M50b. genTitle：去引号截断', title === '公园散步计划', `title=${title}`);
  }

  // M51. v1.18.1 破限白名单：无权限开破限 → 403；管理员授权后可开；撤销后 canUseJailbreak=false
  let m51uid = null; let m51chId = null; const jarU51 = makeJar();
  {
    const { canUseJailbreak } = await import('../src/auth.js');
    const regU = await req('POST', '/api/auth/register', { username: 'm51user', password: 'password123' }, { jar: jarU51 });
    m51uid = regU.json.user.id;
    const chU = await req('POST', '/api/characters', { name: 'M51角色' }, { jar: jarU51 });
    m51chId = chU.json.id;
    const forbid = await req('PUT', `/api/characters/${m51chId}`, { jailbreak_preset: 'qwen-rp' }, { jar: jarU51 });
    const grant = await req('PUT', `/api/admin/users/${m51uid}/jailbreak`, { allowed: true }, { jar: jarAdminM });
    const allow = await req('PUT', `/api/characters/${m51chId}`, { jailbreak_preset: 'qwen-rp' }, { jar: jarU51 });
    const me = await req('GET', '/api/auth/me', undefined, { jar: jarU51 });
    const revoke = await req('PUT', `/api/admin/users/${m51uid}/jailbreak`, { allowed: false }, { jar: jarAdminM });
    ok(
      'M51. 破限白名单：无权限403/授权后可开/me带权限/撤销后失效',
      forbid.status === 403 && /管理员授权/.test(forbid.json.error || '') &&
        grant.status === 200 && grant.json.jailbreak_allowed === true &&
        allow.status === 200 &&
        me.json.user.jailbreak_allowed === true &&
        revoke.status === 200 && canUseJailbreak(m51uid) === false,
      `forbid=${forbid.status} grant=${grant.status} allow=${allow.status} me=${me.json.user.jailbreak_allowed} revoke=${revoke.status}`
    );
  }

  // M51b. v1.18.1 撤销前后聊天注入对比（fake 上游抓 system prompt）
  {
    const http = await import('node:http');
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
    const { resetDispatcher } = await import('../src/llm.js'); // 与 app 同实例，重置 dispatcher 避开代理
    resetDispatcher();
    await req('PUT', `/api/admin/users/${m51uid}/jailbreak`, { allowed: true }, { jar: jarAdminM });
    await req('PUT', `/api/characters/${m51chId}`, { jailbreak_preset: 'qwen-rp' }, { jar: jarU51 });
    await req('POST', '/api/admin/points/grant', { username: 'm51user', points: 100 }, { jar: jarAdminM });
    let sys = '';
    const fake = http.createServer((rq, rs) => {
      let buf = '';
      rq.on('data', (c) => { buf += c; });
      rq.on('end', () => {
        let body = {};
        try { body = JSON.parse(buf); } catch {}
        if (body.stream) {
          const s = (body.messages || []).find((m) => m.role === 'system');
          sys = (s && s.content) || '';
          rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
          rs.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
          rs.write('data: [DONE]\n\n');
          rs.end();
        } else {
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({ choices: [{ message: { content: '测试标题' } }] }));
        }
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    const oldBase = process.env.OPENROUTER_BASE_URL;
    const oldKey = process.env.OPENROUTER_API_KEY;
    const oldMock = process.env.MOCK_LLM;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENROUTER_API_KEY = 'sk-test-123';
    process.env.MOCK_LLM = '';
    let hasJb1 = false; let st1 = 0; let hasJb2 = true; let st2 = 0;
    try {
      const cv1 = await req('POST', `/api/characters/${m51chId}/conversations`, {}, { jar: jarU51 });
      const r1 = await postSSE(`/api/conversations/${cv1.json.id}/messages`, { content: 'hello' }, { jar: jarU51 });
      st1 = r1.status; hasJb1 = sys.includes('叙事不断流');
      await req('PUT', `/api/admin/users/${m51uid}/jailbreak`, { allowed: false }, { jar: jarAdminM });
      const cv2 = await req('POST', `/api/characters/${m51chId}/conversations`, {}, { jar: jarU51 });
      const r2 = await postSSE(`/api/conversations/${cv2.json.id}/messages`, { content: 'hello' }, { jar: jarU51 });
      st2 = r2.status; hasJb2 = sys.includes('叙事不断流');
    } finally {
      process.env.MOCK_LLM = oldMock;
      if (oldBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = oldBase;
      if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
      fake.close();
    }
    ok(
      'M51b. 授权时聊天注入破限词/撤销后不再注入',
      st1 === 200 && hasJb1 && st2 === 200 && !hasJb2,
      `st1=${st1} hasJb1=${hasJb1} st2=${st2} hasJb2=${hasJb2}`
    );
  }

  // M52. v1.18.1 积分管理：直接设余额；注册送积分可配置
  {
    const set1 = await req('POST', '/api/admin/points/set', { username: 'm51user', balance: 1234 }, { jar: jarAdminM });
    const bal1 = await req('GET', '/api/points', undefined, { jar: jarU51 });
    const setNoAuth = await req('POST', '/api/admin/points/set', { username: 'm51user', balance: 9999 }, { jar: jarU51 });
    const setBad = await req('POST', '/api/admin/points/set', { username: 'm51user', balance: -5 }, { jar: jarAdminM });
    // 注册送积分改成 200，新用户首聊验证
    const cfgSet = await req('PUT', '/api/admin/settings', { signup_bonus: 200 }, { jar: jarAdminM });
    const jarN = makeJar();
    await req('POST', '/api/auth/register', { username: 'm52user', password: 'password123' }, { jar: jarN });
    const chN = await req('POST', '/api/characters', { name: 'M52' }, { jar: jarN });
    const cvN = await req('POST', `/api/characters/${chN.json.id}/conversations`, {}, { jar: jarN });
    await postSSE(`/api/conversations/${cvN.json.id}/messages`, { content: 'hi' }, { jar: jarN });
    const balN = await req('GET', '/api/points', undefined, { jar: jarN });
    const cfgBad = await req('PUT', '/api/admin/settings', { signup_bonus: -1 }, { jar: jarAdminM });
    ok(
      'M52. 积分管理：设余额/非管理员403/非法值400；注册送可配200新用户到账',
      set1.status === 200 && set1.json.balance === 1234 &&
        bal1.json && bal1.json.balance === 1234 &&
        setNoAuth.status === 403 && setBad.status === 400 &&
        cfgSet.status === 200 &&
        balN.json && balN.json.balance === 200 &&
        cfgBad.status === 400,
      `set1=${set1.status} bal1=${bal1.json && bal1.json.balance} noAuth=${setNoAuth.status} bad=${setBad.status} cfg=${cfgSet.status} balN=${balN.json && balN.json.balance} cfgBad=${cfgBad.status}`
    );
  }

  // M53. v1.18.3 模型分布加用途维度（reason + reason_label）
  {
    const mo = await req('GET', '/api/admin/stats/models', undefined, { jar: jarAdminM });
    const rows = Array.isArray(mo.json) ? mo.json : [];
    ok(
      'M53. 模型分布：按 model,reason 分组且带中文用途',
      mo.status === 200 && rows.every((r) => r.model && r.reason && r.reason_label) &&
        rows.some((r) => r.reason === 'chat' && r.reason_label === '聊天消耗'),
      `rows=${rows.length} sample=${rows[0] ? rows[0].reason + '/' + rows[0].reason_label : 'none'}`
    );
  }

  // M54. v1.19.0 自带 Key 调用统计：recordByokUsage 写表；统计接口带新字段
  {
    const { recordByokUsage } = await import('../src/points.js');
    const jarT54 = makeJar();
    const reg = await req('POST', '/api/auth/register', { username: 'm54user', password: 'password123' }, { jar: jarT54 });
    const uid54 = reg.json.user.id;
    recordByokUsage(uid54, 'test/model-x', 'chat', { input: 100, output: 50 });
    recordByokUsage(uid54, 'test/model-x', 'memory', { input: 10, output: 5 });
    const am = await req('GET', '/api/admin/stats/api-models', undefined, { jar: jarAdminM });
    const rows = Array.isArray(am.json) ? am.json : [];
    const da = await req('GET', '/api/admin/stats/daily?days=1', undefined, { jar: jarAdminM });
    const tu = await req('GET', '/api/admin/stats/top-users?limit=50', undefined, { jar: jarAdminM });
    const me54 = (Array.isArray(tu.json) ? tu.json : []).find((u) => u.username === 'm54user');
    const apiSum = Array.isArray(da.json) ? da.json.reduce((s, d) => s + (d.apiCalls || 0), 0) : -1;
    ok(
      'M54. BYOK统计：写表/api-models/趋势apiCalls/Top表api_calls',
      rows.some((r) => r.model === 'test/model-x' && r.reason === 'chat' && r.calls === 1 && r.reason_label) &&
        rows.some((r) => r.model === 'test/model-x' && r.reason === 'memory') &&
        Array.isArray(da.json) && da.json.every((d) => typeof d.apiCalls === 'number') &&
        apiSum >= 2 && me54 && me54.api_calls >= 2,
      `apiModels=${rows.length} apiSum=${apiSum} topApi=${me54 && me54.api_calls}`
    );
  }

  // M55. v1.20.0 提供商预设：/api/providers、thinkingParams、provider 持久化、连通性测试接口
  {
    const prov = await req('GET', '/api/providers');
    const ids = Array.isArray(prov.json) ? prov.json.map((p) => p.id) : [];
    const { thinkingParams, getProvider, detectProvider } = await import('../src/providers.js');
    const tpOk =
      JSON.stringify(thinkingParams('dashscope', 'qwen-plus')) === JSON.stringify({ enable_thinking: false }) &&
      JSON.stringify(thinkingParams('zhipu', 'glm-4.6')) === JSON.stringify({ thinking: { type: 'disabled' } }) &&
      JSON.stringify(thinkingParams('openrouter', 'x/y')) === JSON.stringify({ reasoning: { enabled: false } }) &&
      JSON.stringify(thinkingParams('deepseek', 'deepseek-reasoner')) === JSON.stringify({}) &&
      thinkingParams('custom', 'qwen-plus').enable_thinking === false &&
      getProvider('nope').id === 'custom' &&
      detectProvider('https://dashscope-intl.aliyuncs.com/compatible-mode/v1') === 'dashscope';
    // provider 持久化
    const { setUserApiKeys, getUserApiKeys } = await import('../src/auth.js');
    const jarT55 = makeJar();
    const reg = await req('POST', '/api/auth/register', { username: 'm55user', password: 'password123' }, { jar: jarT55 });
    const uid55 = reg.json.user.id;
    setUserApiKeys(uid55, { provider: 'dashscope' });
    const saved55 = getUserApiKeys(uid55);
    // 连通性测试：非法域名 → ok:false（不依赖外网）
    const t = await req('POST', '/api/user/api-key/test',
      { provider: 'dashscope', baseUrl: 'https://invalid.invalid/v1', key: 'sk-test', model: 'qwen-plus' },
      { jar: jarT55 });
    ok(
      'M55. 提供商预设：列表/thinking参数/持久化/测试接口',
      prov.status === 200 && ['openrouter', 'dashscope', 'deepseek', 'zhipu', 'custom'].every((id) => ids.includes(id)) &&
        tpOk && saved55.provider === 'dashscope' &&
        t.status === 200 && t.json && t.json.ok === false && typeof t.json.error === 'string',
      `providers=${ids.join(',')} saved=${saved55.provider} testOk=${t.json && t.json.ok}`
    );
  }

  // M56. v1.20.3 重新生成：删最后一条 AI 回复并返回上一条用户消息；最后一条非 AI 回复时 400；他人对话 404
  {
    // M12 已登出 jarA：用新 jar 重新登录
    const jarA56 = makeJar();
    const jarB56 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA56 });
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB56 });
    const cv = await req('POST', `/api/characters/${charA}/conversations`, {}, { jar: jarA56 });
    const convR = cv.json && cv.json.id;
    const db = getDb();
    const t = new Date().toISOString();
    db.prepare('INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?,?,?,?)').run(convR, 'user', '第一问', t);
    db.prepare('INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?,?,?,?)').run(convR, 'assistant', '半截回复', t);
    const r1 = await req('POST', `/api/conversations/${convR}/regenerate`, {}, { jar: jarA56 });
    const left = db.prepare('SELECT role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(convR);
    const r2 = await req('POST', `/api/conversations/${convR}/regenerate`, {}, { jar: jarA56 });
    const r3 = await req('POST', `/api/conversations/${convR}/regenerate`, {}, { jar: jarB56 });
    ok(
      'M56. regenerate：删AI回复/返回用户问题；再调400；他人404',
      cv.status === 201 && !!convR &&
        r1.status === 200 && r1.json && r1.json.content === '第一问' &&
        left && left.role === 'user' &&
        r2.status === 400 &&
        r3.status === 404,
      `r1=${r1.status} left=${left && left.role} r2=${r2.status} r3=${r3.status}`
    );
  }

  // M57. v1.20.5 消息删除 + @接龙 mention 检测
  {
    const { findMentionedIds } = await import('../src/memory.js');
    const mems = [
      { id: 'a', name: '小晴' },
      { id: 'b', name: '阿默' },
      { id: 'c', name: '小白' },
    ];
    const f1 = findMentionedIds('嗨 @阿默 你来说两句', mems, ['a']);
    const f2 = findMentionedIds('没人被点名', mems, []);
    const f3 = findMentionedIds('@小晴 @阿默 都来', mems, ['a']);
    const jarA57 = makeJar();
    const jarB57 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA57 });
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB57 });
    const cv = await req('POST', `/api/characters/${charA}/conversations`, {}, { jar: jarA57 });
    const convD = cv.json && cv.json.id;
    const db = getDb();
    const t = new Date().toISOString();
    const m1 = db
      .prepare('INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?,?,?,?)')
      .run(convD, 'user', 'q1', t);
    db.prepare('INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?,?,?,?)').run(
      convD,
      'assistant',
      'a1',
      t
    );
    // 删单条
    const d1 = await req('DELETE', `/api/messages/${m1.lastInsertRowid}`, undefined, { jar: jarA57 });
    const left1 = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convD).c;
    // 不存在的消息 → 404
    const dBad = await req('DELETE', '/api/messages/999999999', undefined, { jar: jarA57 });
    // 别人的消息 → 404
    const otherMsg = db.prepare('SELECT id FROM messages WHERE conversation_id = ? LIMIT 1').get(convD);
    const dOther = await req('DELETE', `/api/messages/${otherMsg.id}`, undefined, { jar: jarB57 });
    // 清空
    const c1 = await req('DELETE', `/api/conversations/${convD}/messages`, undefined, { jar: jarA57 });
    const left2 = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convD).c;
    ok(
      'M57. 删单条/清空/404/@检测',
      JSON.stringify(f1) === JSON.stringify(['b']) &&
        f2.length === 0 &&
        JSON.stringify(f3) === JSON.stringify(['b']) &&
        d1.status === 200 && left1 === 1 &&
        dBad.status === 404 &&
        dOther.status === 404 &&
        c1.status === 200 && left2 === 0,
      `f1=${JSON.stringify(f1)} d1=${d1.status} left1=${left1} dOther=${dOther.status} clear=${c1.status} left2=${left2}`
    );
  }

  // M58. v1.21.0 群聊上下文架构：①群成员人设 ②排除已摘要 ④已读水位 ⑤batch_id ⑥OpenAI结构化
  {
    const { buildGroupContext, oneLineDesc } = await import('../src/memory.js');
    const db = getDb();
    const jarM58 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarM58 });
    const c1 = await req('POST', '/api/characters', { name: 'M58A' }, { jar: jarM58 });
    const c2 = await req('POST', '/api/characters', { name: 'M58B' }, { jar: jarM58 });
    const g = await req('POST', '/api/groups', { member_ids: [c1.json.id, c2.json.id] }, { jar: jarM58 });
    const gid = g.json && g.json.id;
    const t0 = c1.status === 201 && c2.status === 201 && g.status === 201 && !!gid;
    let t1 = false, t5 = false, t4 = false, t6 = false, t2 = false;
    if (t0) {
    const members = [
      { id: c1.json.id, name: 'M58A', soul_md: '# 身份\nA是话痨' },
      { id: c2.json.id, name: 'M58B', soul_md: '# 身份\nB是吃货' },
    ];
    // ① system 含 #群成员段：有对方一句话人设、无自己
    const sysA = buildGroupContext(members, gid, 'hi', 'mock').buildFor(members[0]).apiMessages[0].content;
    t1 = sysA.includes('# 群成员') && sysA.includes('M58B') && sysA.includes('B是吃货') && !/M58A：/.test(sysA) &&
      oneLineDesc('# 身份\nA是话痨') === 'A是话痨';
    // 发一轮（@M58A 只让 A 回），产生 user 消息 + A 回复
    const { events } = await postSSE(`/api/conversations/${gid}/messages`, { content: '来说两句@M58A' }, { jar: jarM58 });
    const starts = events.filter((e) => e.event === 'turn_start');
    const batchIds = starts.map((e) => e.data && e.data.batch_id).filter(Boolean);
    // ⑤ turn_start 带 batch_id；DB 里本轮消息共享同一 batch_id
    const dbBatches = db.prepare('SELECT DISTINCT batch_id AS b FROM messages WHERE conversation_id = ?').all(gid).map((r) => r.b);
    t5 = starts.length === 1 && batchIds.length === 1 && dbBatches.length === 1 && dbBatches[0] === batchIds[0];
    // ④ 已读水位：A 发言后 group_read_marks 有记录且 upto=其回复 id
    const marks = db.prepare('SELECT character_id, upto_message_id AS u FROM group_read_marks WHERE conversation_id = ?').all(gid);
    const replyId = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND character_id = ? ORDER BY id DESC LIMIT 1').get(gid, c1.json.id);
    t4 = marks.length === 1 && marks[0].character_id === c1.json.id && replyId && marks[0].u === replyId.id;
    // ⑥ 结构化：A 自己的历史标 assistant + name=m_<id>；用户消息标 user + name=user
    const hist = buildGroupContext(members, gid, 'hi', 'mock').buildFor(members[0]).apiMessages.slice(1);
    const selfMsg = hist.find((m) => m.role === 'assistant');
    const userMsg = hist.find((m) => m.role === 'user' && m.name === 'user');
    t6 = !!selfMsg && selfMsg.name === 'm_' + String(c1.json.id).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60) &&
      !!userMsg && userMsg.content.startsWith('用户：');
    // ② 排除已摘要：插 3 条旧消息 + 摘要 upto 覆盖它们，history 不再含旧原文
    const t = new Date().toISOString();
    const olds = [];
    for (let i = 0; i < 3; i++) {
      olds.push(db.prepare('INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?,?,?,?)').run(gid, 'user', `old-${i}`, t).lastInsertRowid);
    }
    const maxOld = Math.max(...olds.map(Number));
    db.prepare('INSERT INTO conversation_summaries(conversation_id, summary, message_upto, created_at) VALUES(?,?,?,?)')
      .run(gid, '旧摘要', maxOld, t);
    const hist2 = buildGroupContext(members, gid, 'hi', 'mock').buildFor(members[1]).apiMessages.slice(1);
    t2 = !hist2.some((m) => /old-[012]/.test(m.content));
    } // end if (t0)
    if (gid) await req('DELETE', `/api/conversations/${gid}`, undefined, { jar: jarM58 });
    if (c1.json) await req('DELETE', `/api/characters/${c1.json.id}`, undefined, { jar: jarM58 });
    if (c2.json) await req('DELETE', `/api/characters/${c2.json.id}`, undefined, { jar: jarM58 });
    ok(
      'M58. 群成员段/排除已摘要/水位/batch_id/结构化',
      t0 && t1 && t5 && t4 && t6 && t2,
      `t0=${t0}(c1=${c1.status} c2=${c2.status} g=${g.status}) t1=${t1} t5=${t5} t4=${t4} t6=${t6} t2=${t2}`
    );
  }

  // M59. v1.22.0 Bug1: 单聊重新生成不重复落库用户消息；Bug2: 群聊 turn_done 带 truncated + regenerate-turn
  {
    const db = getDb();
    const jarA59 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA59 });
    // --- Bug1: 单聊 regenerate(true) 不重复插入用户消息 ---
    const cv = await req('POST', `/api/characters/${charA}/conversations`, {}, { jar: jarA59 });
    const convR = cv.json && cv.json.id;
    const t = new Date().toISOString();
    db.prepare('INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?,?,?,?)').run(convR, 'user', '第一问', t);
    db.prepare('INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?,?,?,?)').run(convR, 'assistant', '半截回复', t);
    const rg1 = await req('POST', `/api/conversations/${convR}/regenerate`, {}, { jar: jarA59 });
    // 用 regenerate=true 重发（SSE，mock 下快速完成）
    const sse1 = await postSSE(`/api/conversations/${convR}/messages`, { regenerate: true }, { jar: jarA59 });
    const userCount = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND role = 'user'").get(convR).c;
    const asstCount = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(convR).c;
    const doneEv = sse1.events.find((e) => e.event === 'done');
    const b1 = rg1.status === 200 && sse1.status === 200 && userCount === 1 && asstCount === 1 && !!doneEv;
    // --- Bug2: 群聊 turn_done 带 truncated；regenerate-turn 删半截重跑单轮 ---
    const gc1 = await req('POST', '/api/characters', { name: 'M59A' }, { jar: jarA59 });
    const gc2 = await req('POST', '/api/characters', { name: 'M59B' }, { jar: jarA59 });
    const gg = await req('POST', '/api/groups', { member_ids: [gc1.json.id, gc2.json.id] }, { jar: jarA59 });
    const gid = gg.json && gg.json.id;
    let b2 = false, b3 = false;
    if (gid) {
      const gs = await postSSE(`/api/conversations/${gid}/messages`, { content: '来说两句@M59A' }, { jar: jarA59 });
      const turnDones = gs.events.filter((e) => e.event === 'turn_done');
      b2 = turnDones.length === 1 && 'truncated' in (turnDones[0].data || {});
      const mid = turnDones[0] && turnDones[0].data && turnDones[0].data.message_id;
      if (mid) {
        const rs = await postSSE(`/api/conversations/${gid}/regenerate-turn`, { message_id: mid }, { jar: jarA59 });
        const rTurns = rs.events.filter((e) => e.event === 'turn_done');
        const rDones = rs.events.filter((e) => e.event === 'done');
        const msgCount = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(gid).c;
        // 原 2 条（user+assistant），删半截后重跑 1 轮 → 仍是 2 条，且新 turn 有 truncated 字段
        b3 = rs.status === 200 && rTurns.length === 1 && rDones.length === 1 &&
          'truncated' in (rTurns[0].data || {}) && msgCount === 2;
      }
      await req('DELETE', `/api/conversations/${gid}`, undefined, { jar: jarA59 });
    }
    if (gc1.json) await req('DELETE', `/api/characters/${gc1.json.id}`, undefined, { jar: jarA59 });
    if (gc2.json) await req('DELETE', `/api/characters/${gc2.json.id}`, undefined, { jar: jarA59 });
    await req('DELETE', `/api/conversations/${convR}`, undefined, { jar: jarA59 });
    ok(
      'M59. 单聊regenerate不重复用户消息/群聊truncated/regenerate-turn',
      b1 && b2 && b3,
      `b1=${b1}(user=${userCount} asst=${asstCount}) b2=${b2} b3=${b3}`
    );
  }

  // M60. v1.22.2: regenerate-turn 支持 character_id+batch_id 定位（断流无 message_id 时）
  {
    const db = getDb();
    const jarA60 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA60 });
    const gc1 = await req('POST', '/api/characters', { name: 'M60A' }, { jar: jarA60 });
    const gc2 = await req('POST', '/api/characters', { name: 'M60B' }, { jar: jarA60 });
    const gg = await req('POST', '/api/groups', { member_ids: [gc1.json.id, gc2.json.id] }, { jar: jarA60 });
    const gid = gg.json && gg.json.id;
    let b1 = false, b2 = false;
    if (gid) {
      const gs = await postSSE(`/api/conversations/${gid}/messages`, { content: '来说两句@M60A' }, { jar: jarA60 });
      const turnDones = gs.events.filter((e) => e.event === 'turn_done');
      const td = turnDones[0] && turnDones[0].data;
      const cid = td && td.character_id;
      const batchId = td && td.batch_id;
      // 用 character_id+batch_id（不用 message_id）调 regenerate-turn，应同样删半截重跑
      if (cid && batchId) {
        const rs = await postSSE(
          `/api/conversations/${gid}/regenerate-turn`,
          { character_id: cid, batch_id: batchId },
          { jar: jarA60 }
        );
        const rTurns = rs.events.filter((e) => e.event === 'turn_done');
        const msgCount = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(gid).c;
        b1 = rs.status === 200 && rTurns.length === 1 && msgCount === 2;
      }
      // message_id 指向不存在的消息应 400（明确引用错误不静默）
      const bad = await req('POST', `/api/conversations/${gid}/regenerate-turn`, { message_id: 99999999 }, { jar: jarA60 });
      b2 = bad.status === 400;
      await req('DELETE', `/api/conversations/${gid}`, undefined, { jar: jarA60 });
    }
    if (gc1.json) await req('DELETE', `/api/characters/${gc1.json.id}`, undefined, { jar: jarA60 });
    if (gc2.json) await req('DELETE', `/api/characters/${gc2.json.id}`, undefined, { jar: jarA60 });
    ok('M60. regenerate-turn按character_id+batch_id定位', b1 && b2, `b1=${b1} b2=${b2}`);
  }

  // M61. v1.24.0: 裸名提及检测 + 轻模型兜底
  {
    const { findMentionedIds } = await import('../src/memory.js');
    const { detectMentions } = await import('../src/llm.js');
    const mems = [
      { id: 'a', name: '小晴' },
      { id: 'b', name: '阿默' },
      { id: 'c', name: '风' }, // 单字名
    ];
    // @ 显式提及（老行为）
    const g1 = findMentionedIds('嗨 @阿默 你来说', mems, []);
    // 裸名+标点/称谓（v1.24.0 新增）
    const g2 = findMentionedIds('小晴，你说得对', mems, []);
    const g3 = findMentionedIds('阿默你觉得呢？', mems, []);
    const g4 = findMentionedIds('小晴！快来', mems, []);
    // 单字名裸写不触发（防误触），@才触发
    const g5 = findMentionedIds('今天风很大', mems, []);
    const g6 = findMentionedIds('问下 @风', mems, []);
    // 无提及
    const g7 = findMentionedIds('大家好', mems, []);
    // mock 下轻模型返回 []
    const g8 = await detectMentions({ text: '小晴你说得对', members: mems, excludeIds: [] });
    ok(
      'M61. 裸名提及/单字名防误触/轻模型mock',
      JSON.stringify(g1) === JSON.stringify(['b']) &&
        JSON.stringify(g2) === JSON.stringify(['a']) &&
        JSON.stringify(g3) === JSON.stringify(['b']) &&
        JSON.stringify(g4) === JSON.stringify(['a']) &&
        g5.length === 0 &&
        JSON.stringify(g6) === JSON.stringify(['c']) &&
        g7.length === 0 &&
        Array.isArray(g8) && g8.length === 0,
      `g1=${JSON.stringify(g1)} g2=${JSON.stringify(g2)} g5=${JSON.stringify(g5)} g8=${JSON.stringify(g8)}`
    );
  }

  // M64. v1.28.2: 群聊重试不叠加——regenerate 重试只跑未成功回复的角色，已回过的不再重跑
  {
    const db = getDb();
    const jarA64 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA64 });
    const gc1 = await req('POST', '/api/characters', { name: 'M64A' }, { jar: jarA64 });
    const gc2 = await req('POST', '/api/characters', { name: 'M64B' }, { jar: jarA64 });
    const gg = await req('POST', '/api/groups', { member_ids: [gc1.json.id, gc2.json.id] }, { jar: jarA64 });
    const gid = gg.json && gg.json.id;
    let pass = false, detail = '';
    if (gid) {
      const userCount = () =>
        db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND role = 'user'").get(gid).c;
      const asstCount = () =>
        db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(gid).c;
      const r1 = await postSSE(`/api/conversations/${gid}/messages`, { content: 'M64叠加测试' }, { jar: jarA64 });
      const u1 = userCount(), n1 = asstCount();
      // 模拟失败后点重试：同内容 + regenerate
      const r2 = await postSSE(
        `/api/conversations/${gid}/messages`,
        { content: 'M64叠加测试', regenerate: true },
        { jar: jarA64 }
      );
      const u2 = userCount(), n2 = asstCount();
      pass = r1.status === 200 && r2.status === 200 && u1 === 1 && u2 === 1 && n1 > 0 && n2 === n1;
      detail = `u1=${u1} u2=${u2} n1=${n1} n2=${n2}`;
      await req('DELETE', `/api/conversations/${gid}`, undefined, { jar: jarA64 });
    }
    if (gc1.json) await req('DELETE', `/api/characters/${gc1.json.id}`, undefined, { jar: jarA64 });
    if (gc2.json) await req('DELETE', `/api/characters/${gc2.json.id}`, undefined, { jar: jarA64 });
    ok('M64. 群聊regenerate重试不叠加已回复角色', pass, detail);
  }

  // M65. v1.29.0: 系统内置音色——空表时 GET 返回空数组；非管理员批量克隆 → 403
  {
    const db = getDb();
    db.prepare('DELETE FROM builtin_voices').run();
    // testuserB 密码已被 M32 改为 newpassword123，用新会话登录
    const jarB65 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB65 });
    const empty = await req('GET', '/api/voice/builtin', undefined, { jar: jarB65 });
    const forbid = await req('POST', '/api/admin/voice/batch-clone', { voices: [] }, { jar: jarB65 });
    ok(
      'M65. 内置音色列表为空；非管理员批量克隆 → 403',
      empty.status === 200 && Array.isArray(empty.json.voices) && empty.json.voices.length === 0 &&
        forbid.status === 403,
      `emptyStatus=${empty.status} empty=${empty.json && empty.json.voices && empty.json.voices.length} forbid=${forbid.status}`
    );
  }

  // M66. v1.29.0: 批量克隆 job（mock 模式）——上传 2 个音频 → 轮询完成 → builtin_voices 入库
  {
    const db = getDb();
    db.prepare('DELETE FROM builtin_voices').run();
    const fakeAudio = Buffer.alloc(2048, 7).toString('base64');
    const start = await req('POST', '/api/admin/voice/batch-clone', {
      voices: [
        { name: '测试音A', audio: fakeAudio, mimeType: 'audio/wav' },
        { name: '测试音B', audio: fakeAudio, mimeType: 'audio/wav' },
      ],
    }, { jar: jarAdminM });
    let job = null;
    if (start.status === 200 && start.json.job_id) {
      for (let i = 0; i < 20 && (!job || job.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 500));
        const st = await req('GET', `/api/admin/voice/batch-clone/${start.json.job_id}`, undefined, { jar: jarAdminM });
        if (st.status === 200) job = st.json;
      }
    }
    const rows = db.prepare('SELECT name, voice_id, target_model FROM builtin_voices ORDER BY sort').all();
    const pass = job && job.status === 'done' && job.done === 2 &&
      job.results.every((r) => r.ok) && rows.length === 2 &&
      rows.every((r) => r.voice_id && r.voice_id.startsWith('mock_clone_')) &&
      rows.every((r) => r.target_model === 'cosyvoice-v3.5-plus');
    ok(
      'M66. 批量克隆 2 个 → job 完成 → builtin_voices 入库（带 target_model）',
      pass,
      `job=${job && job.status} done=${job && job.done} rows=${rows.length}`
    );
    db.prepare('DELETE FROM builtin_voices').run();
  }

  // M67. v1.29.0: 内置克隆音色 TTS 走 VC 模型（而非默认 TTS 模型）
  {
    const db = getDb();
    db.prepare('DELETE FROM builtin_voices').run();
    db.prepare(`INSERT INTO builtin_voices(name, voice_id, target_model, gender, description, preview, sort, created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('测试音C', 'mock_voice_vc_001', 'cosyvoice-v3.5-plus', '女', '测试', '你好', 0, new Date().toISOString());
    const jarB67 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB67 });
    const r = await req('POST', '/api/voice/tts', { text: 'M67测试', voice: 'mock_voice_vc_001', forceAll: true }, { jar: jarB67 });
    const pass = r.status === 200 && r.json.model === 'cosyvoice-v3.5-plus';
    ok(
      'M67. 内置克隆音色 TTS 走 VC 模型',
      pass,
      `status=${r.status} model=${r.json && r.json.model}`
    );
    db.prepare('DELETE FROM builtin_voices').run();
  }

  // M68. v1.29.5: CosyVoice 模型走百炼原生 HTTP 接口（非 compatible-mode）
  {
    const { getVoiceProvider, resetVoiceProvider } = await import('../src/voice.js');
    resetVoiceProvider();
    const provider = getVoiceProvider();
    // 绕过 mock：直接测 ttsCosyvoice 的 URL 与参数
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (String(url).includes('/multimodal-generation/generation')) {
        return { ok: true, json: async () => ({ output: { task_id: 'task_123' } }) };
      }
      if (String(url).includes('/api/v1/tasks/task_123')) {
        return { ok: true, json: async () => ({ output: { task_status: 'SUCCEEDED', results: [{ audio: { url: 'https://example.com/a.mp3' } }] } }) };
      }
      if (url === 'https://example.com/a.mp3') {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    };
    let pass = false, detail = '';
    try {
      // 注意：mockLlm=true 时 tts() 直接返回 mock，这里直接调 ttsCosyvoice 验证协议
      const r = await provider.ttsCosyvoice('你好', { model: 'cosyvoice-v3.5-plus', voice: 'voice_abc' });
      const submit = calls.find((c) => c.url.includes('/multimodal-generation/generation'));
      pass = !!submit
        && submit.body.model === 'cosyvoice-v3.5-plus'
        && submit.body.input.text === '你好'
        && submit.body.input.voice === 'voice_abc'
        && r.audio && r.audio.length === 8;
      detail = `submit=${submit ? submit.url : 'none'} audioLen=${r.audio && r.audio.length}`;
    } catch (e) {
      detail = '异常: ' + (e && e.message);
    } finally {
      global.fetch = origFetch;
      resetVoiceProvider();
    }
    ok('M68. CosyVoice 走原生 HTTP 接口', pass, detail);
  }

  // M69. v1.29.6: 内置音色参考音频接口（无音频时 404）
  {
    const jarA69 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserA', password: 'password123' }, { jar: jarA69 });
    // 非管理员 403（testuserB 非首个注册用户）
    const jarB69 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB69 });
    const r1 = await req('GET', '/api/admin/voice/builtin/不存在的音色/audio', undefined, { jar: jarB69 });
    const r2 = await req('GET', '/api/admin/voice/builtin/不存在的音色/audio', undefined, { jar: jarA69 });
    // testuserA 是管理员（首个注册用户），应 404（无参考音频）；testuserB 非管理员应 403
    const pass = r1.status === 403 && r2.status === 404;
    ok('M69. 参考音频接口鉴权与404', pass, `nonAdmin=${r1.status} admin=${r2.status}`);
  }

  // M38. v1.12 记忆事件隔离：B 读不到 A 的对话事件
  {
    const db = getDb();
    db.prepare('INSERT INTO memory_events(conversation_id, character_id, created_at, facts_added, user_md_changed) VALUES(?,?,?,?,?)').run(
      convA, charA, new Date().toISOString(), 1, 0
    );
    const jarB38 = makeJar();
    await req('POST', '/api/auth/login', { username: 'testuserB', password: 'newpassword123' }, { jar: jarB38 });
    const bEv = await req('GET', `/api/conversations/${convA}/memory-events`, undefined, { jar: jarB38 });
    ok(
      'M38. B 读 A 的 memory-events → 404',
      bEv.status === 404,
      `status=${bEv.status}`
    );
  }
}
