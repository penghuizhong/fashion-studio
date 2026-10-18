// P4 发散创建：发散引擎（纯函数）+ 渲染复用
import { getConfig } from './config.js';
import { getDb } from './db.js';
import { ah } from './asyncHandler.js';
import { llmCreds } from './auth.js';
import { listImageModelsCompat } from './registry.js';
import { calcPoints, deductPoints } from './points.js';
import { postJson, stripFences } from './llm.js';
import { renderDnaPrompt, generateImage, saveStudioImage } from './image.js';

// DNA 11 字段（与 extractDna 对齐）
export const DNA_FIELDS = [
  'category', 'silhouette', 'collar', 'sleeve', 'skirt', 'fabric',
  'primary_color', 'secondary_color', 'style', 'details', 'scene',
];

const AXIS_SEEDS = {
  silhouette: ['A字型', '茧型', '修身', '宽松直筒'],
  fabric: ['真丝', '棉麻', '牛仔', '针织'],
  style: ['极简', '复古', '街头', '优雅'],
  details: ['刺绣', '褶皱', '镂空', '拼接'],
  scene: ['日常通勤', '度假', '晚宴', '街头'],
  category: ['连衣裙', '半裙', '外套', '衬衫'],
  collar: ['圆领', 'V领', '立领', '翻领'],
  sleeve: ['无袖', '短袖', '长袖', '泡泡袖'],
  skirt: ['短裙', '中裙', '长裙', '鱼尾裙'],
  primary_color: ['黑', '白', '米色', '雾蓝'],
  secondary_color: ['金', '银', '红', '墨绿'],
};

function blankDna() {
  const dna = {};
  for (const f of DNA_FIELDS) dna[f] = { value: '', confidence: 0 };
  return dna;
}

function normalizeDna(raw) {
  const dna = blankDna();
  if (raw && typeof raw === 'object') {
    for (const f of DNA_FIELDS) {
      const v = raw[f];
      if (v && typeof v === 'object' && 'value' in v) {
        dna[f] = { value: v.value == null ? '' : v.value, confidence: Number(v.confidence) || 0 };
      } else if (v != null && typeof v !== 'object') {
        dna[f] = { value: v, confidence: 0.5 };
      }
    }
  }
  return dna;
}

// mock 分支：确定性生成 count 个 DNA，axes 字段轮换取候选值（供回归）
function mockExpand({ axes, count }) {
  const proposals = [];
  for (let i = 0; i < count; i++) {
    const dna = blankDna();
    dna.category = { value: '连衣裙', confidence: 0.9 };
    for (const ax of axes) {
      const seeds = AXIS_SEEDS[ax] || ['方案A', '方案B', '方案C', '方案D'];
      dna[ax] = { value: seeds[i % seeds.length], confidence: 0.8 };
    }
    // 非轴字段填固定合理值
    if (!axes.includes('fabric')) dna.fabric = { value: '棉', confidence: 0.6 };
    if (!axes.includes('style')) dna.style = { value: '简约', confidence: 0.6 };
    proposals.push({ dna, rationale: `mock 候选 ${i + 1}：${axes.map((a) => dna[a].value).join(' / ')}` });
  }
  return proposals;
}

const EXPAND_SYSTEM = `你是服装设计师的灵感发散引擎。用户给出一句灵感（可能为空），你要把它发散成 N 个完整且互异的款式 DNA。

DNA 有 11 个字段，每个字段格式为 {"value": ..., "confidence": 0~1}：
category(品类), silhouette(版型), collar(领型), sleeve(袖型), skirt(裙摆), fabric(面料), primary_color(主色), secondary_color(辅色), style(风格), details(细节), scene(场景)。

严格要求：
1. 只输出 JSON，格式：{"proposals": [{"dna": {11字段}, "rationale": "一句话说明这个方案的差异点"}]}，不要 markdown 代码块之外的任何文字。
2. N 个方案必须在指定的发散轴字段上两两互异（这是发散的核心，不许换汤不换药）。
3. 非轴字段填与灵感自洽的合理值；灵感为空时按当季流行风格自由发散。
4. confidence 按你对该取值的把握填写。`;

/**
 * 发散意图 → N 个完整 DNA
 * @param {Object} p - { intentText, axes, count, model, apiKey, baseUrl, provider, onUsage }
 * @returns {Promise<Array<{dna, rationale}>>}
 */
export async function expandIntent({ intentText, axes, count, model, apiKey, baseUrl, provider, onUsage }) {
  const ax = [...new Set((axes || []).map((a) => String(a).trim()))];
  const n = Math.floor(Number(count)) || 6;
  if (ax.length === 0) throw new Error('至少选择一个发散轴');
  for (const a of ax) {
    if (!DNA_FIELDS.includes(a)) throw new Error(`非法发散轴: ${a}`);
  }
  if (n < 2 || n > 8) throw new Error('候选数量须在 2..8 之间');
  const intent = String(intentText || '').slice(0, 500);

  const cfg = getConfig();
  if (cfg.mockLlm) return mockExpand({ axes: ax, count: n });

  const userPrompt = `灵感：${intent || '（空，按流行风格自由发散）'}\n发散轴：${ax.join(', ')}\n数量：${n}`;
  let lastErr = null;
  for (const temperature of [0.95, 0.8]) {
    const { json, usage } = await postJson({
      model, temperature, apiKey, baseUrl, provider,
      messages: [
        { role: 'system', content: EXPAND_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    });
    if (usage && onUsage) { try { onUsage(usage); } catch {} }
    const text = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    try {
      const parsed = JSON.parse(stripFences(text));
      const list = parsed && parsed.proposals;
      if (!Array.isArray(list) || list.length === 0) throw new Error('上游返回为空');
      const proposals = list.slice(0, n).map((p) => ({
        dna: normalizeDna(p && p.dna),
        rationale: String((p && p.rationale) || '').slice(0, 200),
      }));
      return proposals;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`发散失败：${(lastErr && lastErr.message) || '上游返回无法解析'}`);
}

/**
 * 渲染单个候选（复用 image.js 链路：扣费/落盘/缩略图全在里面）
 * @returns {Promise<{proposal_idx, image_path, thumb_path, seed, model, size, price} | {proposal_idx, error}>}
 */
export async function renderOne({ batch, proposalIdx, userId }) {
  const proposals = JSON.parse(batch.proposals_json || '[]');
  const p = proposals[proposalIdx];
  if (!p) return { proposal_idx: proposalIdx, error: '候选不存在' };
  try {
    const prompt = renderDnaPrompt(p.dna);
    const result = await generateImage({
      userId,
      modelId: batch.render_model_id,
      prompt,
      size: batch.render_size,
    });
    const files = await saveStudioImage(result.imageBase64, `ex_${batch.id}_${proposalIdx}_${Date.now()}.jpg`);
    return {
      proposal_idx: proposalIdx,
      image_path: files.image_path,
      thumb_path: files.thumb_path,
      seed: result.seed,
      model: result.model,
      size: result.size,
      price: result.price,
    };
  } catch (e) {
    return { proposal_idx: proposalIdx, error: (e && e.message) || '渲染失败' };
  }
}

// ---------- 路由 ----------
// P4-3: 全部要登录；multiUser 按 user_id 隔离（与 studio.js 一致）

export const DEFAULT_AXES = ['silhouette', 'fabric', 'style', 'details', 'scene'];

export function mountExploreRoutes(app) {
  const db = getDb();
  const cfg = getConfig();
  const uidOf = (req) => (req && req.userId) || 'local';
  const requestApiKey = (req) => {
    const h = req.headers['x-openrouter-key'];
    return typeof h === 'string' ? h.trim() : '';
  };
  const getBatch = (id, req) => {
    const uid = uidOf(req);
    return cfg.multiUser
      ? db.prepare('SELECT * FROM exploration_batches WHERE id=? AND user_id=?').get(id, uid)
      : db.prepare('SELECT * FROM exploration_batches WHERE id=?').get(id);
  };
  const touch = (id) => db.prepare('UPDATE exploration_batches SET updated_at=? WHERE id=?').run(new Date().toISOString(), id);

  // GET /api/studio/image-models → 可用的图片模型（公开信息，无密钥）
  app.get('/api/studio/image-models', ah(async (req, res) => {
    const ms = listImageModelsCompat(true).map((m) => ({
      id: m.id, model_id: m.model_id, name: m.name,
      price_per_call: m.price_per_call, sizes: m.sizes,
    }));
    res.json({ ok: true, models: ms });
  }));

  // POST /api/studio/explore {intent_text?, axes?, count?, render_model_id?, render_size?}
  app.post('/api/studio/explore', ah(async (req, res) => {
    const uid = uidOf(req);
    const b = req.body || {};
    const axes = Array.isArray(b.axes) && b.axes.length ? b.axes : DEFAULT_AXES;
    const count = Math.floor(Number(b.count)) || 6;
    // 渲染模型：指定 > 最便宜的启用图片模型
    const imgModels = listImageModelsCompat(true);
    let renderModel = b.render_model_id
      ? imgModels.find((m) => m.id === b.render_model_id || m.model_id === b.render_model_id)
      : [...imgModels].sort((x, y) => x.price_per_call - y.price_per_call)[0];
    if (!renderModel) return res.status(400).json({ error: '请先在模型管理里上架图片模型' });
    const renderSize = String(b.render_size || '').trim() || (renderModel.sizes[0] || '1024x1024');
    // 发散（LLM 展开）；计费走后台任务模型
    const creds = llmCreds(req, cfg, requestApiKey);
    const useModel = creds.workerModel;
    let proposals;
    try {
      proposals = await expandIntent({
        intentText: b.intent_text, axes, count,
        model: useModel, apiKey: creds.apiKey, baseUrl: creds.baseUrl, provider: creds.provider,
        onUsage: (usage) => {
          try {
            const pts = calcPoints(useModel, usage);
            if (pts > 0) deductPoints(uid, pts, 'explore_expand', null, null, { model: useModel, tokensInput: usage.input, tokensOutput: usage.output });
          } catch { /* 计费失败不影响主流程 */ }
        },
      });
    } catch (e) {
      const status = /非法|数量/.test(e.message) ? 400 : 502;
      return res.status(status).json({ error: e.message || '发散失败' });
    }
    const now = new Date().toISOString();
    const costEstimate = proposals.length * renderModel.price_per_call;
    const r = db.prepare(`INSERT INTO exploration_batches(user_id,intent_text,axes_json,count,proposals_json,render_model_id,render_size,cost_estimate,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid, String(b.intent_text || '').slice(0, 500), JSON.stringify(axes), proposals.length,
      JSON.stringify(proposals), renderModel.id, renderSize, costEstimate, 'expanded', now, now);
    res.json({
      ok: true, id: r.lastInsertRowid, proposals, cost_estimate: costEstimate,
      render_model: { id: renderModel.id, model_id: renderModel.model_id, price_per_call: renderModel.price_per_call },
    });
  }));

  // POST /api/studio/explore/:id/select {indexes:[]}
  app.post('/api/studio/explore/:id/select', ah(async (req, res) => {
    const batch = getBatch(req.params.id, req);
    if (!batch) return res.status(404).json({ error: '批次不存在' });
    const proposals = JSON.parse(batch.proposals_json || '[]');
    const indexes = Array.isArray((req.body || {}).indexes) ? (req.body || {}).indexes.map((i) => Math.floor(Number(i))) : [];
    for (const i of indexes) {
      if (!Number.isInteger(i) || i < 0 || i >= proposals.length) return res.status(400).json({ error: `候选序号越界: ${i}` });
    }
    const uniq = [...new Set(indexes)];
    db.prepare('UPDATE exploration_batches SET selected_json=?, status=? WHERE id=?').run(JSON.stringify(uniq), 'selected', batch.id);
    touch(batch.id);
    res.json({ ok: true, selected: uniq });
  }));

  // POST /api/studio/explore/:id/render {confirm:true}
  app.post('/api/studio/explore/:id/render', ah(async (req, res) => {
    const batch = getBatch(req.params.id, req);
    if (!batch) return res.status(404).json({ error: '批次不存在' });
    if (!(req.body || {}).confirm) {
      return res.status(400).json({ error: '请确认费用后重试', cost_estimate: batch.cost_estimate });
    }
    const selected = JSON.parse(batch.selected_json || '[]');
    const proposals = JSON.parse(batch.proposals_json || '[]');
    const targets = selected.length ? selected : proposals.map((_, i) => i);
    if (!targets.length) return res.status(400).json({ error: '没有可渲染的候选' });
    db.prepare('UPDATE exploration_batches SET status=? WHERE id=?').run('rendering', batch.id);
    const uid = uidOf(req);
    const renders = [];
    let costActual = 0;
    for (const idx of targets) {
      const r = await renderOne({ batch, proposalIdx: idx, userId: uid });
      renders.push(r);
      if (r.price) costActual += r.price;
    }
    db.prepare('UPDATE exploration_batches SET renders_json=?, cost_actual=?, status=? WHERE id=?')
      .run(JSON.stringify(renders), costActual, 'rendered', batch.id);
    touch(batch.id);
    res.json({ ok: true, renders, cost_actual: costActual });
  }));

  // POST /api/studio/explore/:id/adopt {indexes:[]}
  app.post('/api/studio/explore/:id/adopt', ah(async (req, res) => {
    const batch = getBatch(req.params.id, req);
    if (!batch) return res.status(404).json({ error: '批次不存在' });
    const proposals = JSON.parse(batch.proposals_json || '[]');
    const renders = JSON.parse(batch.renders_json || '[]');
    const renderByIdx = new Map(renders.filter((r) => !r.error).map((r) => [r.proposal_idx, r]));
    const indexes = Array.isArray((req.body || {}).indexes) ? (req.body || {}).indexes.map((i) => Math.floor(Number(i))) : [];
    if (!indexes.length) return res.status(400).json({ error: '请选择要收为款式卡的候选' });
    const uid = uidOf(req);
    const now = new Date().toISOString();
    const templateIds = [];
    for (const idx of [...new Set(indexes)]) {
      const p = proposals[idx];
      if (!p) return res.status(400).json({ error: `候选序号越界: ${idx}` });
      const tr = db.prepare(`INSERT INTO style_dna_templates(user_id,name,dna_json,gen_params_json,status,version,created_at,updated_at)
        VALUES(?,?,?,?,'draft',1,?,?)`).run(
        uid, `发散灵感 #${batch.id}-${idx}`, JSON.stringify(p.dna),
        JSON.stringify({ explore_batch_id: batch.id, proposal_idx: idx }), now, now);
      const tid = tr.lastInsertRowid;
      const r = renderByIdx.get(idx);
      if (r) {
        db.prepare(`INSERT INTO dna_generations(template_id,user_id,image_path,thumb_path,prompt_snapshot,seed,model_id,size,op,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          tid, uid, r.image_path, r.thumb_path, '', r.seed, r.model, r.size, 'explore', now);
      }
      templateIds.push(tid);
    }
    db.prepare('UPDATE exploration_batches SET status=? WHERE id=?').run('adopted', batch.id);
    touch(batch.id);
    res.json({ ok: true, template_ids: templateIds });
  }));

  // GET /api/studio/explore → 列表
  app.get('/api/studio/explore', ah(async (req, res) => {
    const uid = uidOf(req);
    const inc = req.query && req.query.include_archived === '1';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const conds = [];
    const args = [];
    if (cfg.multiUser) { conds.push('user_id=?'); args.push(uid); }
    if (!inc) conds.push('archived=0');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT id,user_id,intent_text,axes_json,count,selected_json,render_model_id,cost_estimate,cost_actual,status,archived,created_at,updated_at,
      json_array_length(proposals_json) AS proposal_count, json_array_length(renders_json) AS render_count
      FROM exploration_batches ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json({ ok: true, batches: rows });
  }));

  // GET /api/studio/explore/:id → 详情
  app.get('/api/studio/explore/:id', ah(async (req, res) => {
    const batch = getBatch(req.params.id, req);
    if (!batch) return res.status(404).json({ error: '批次不存在' });
    res.json({ ok: true, batch });
  }));
}
