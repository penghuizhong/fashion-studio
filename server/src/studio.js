// v0.1.0: 设计台 REST 接口（全部要登录；多用户模式按 user_id 隔离）
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { getConfig } from './config.js';
import { ah } from './asyncHandler.js';
import { llmCreds } from './auth.js';
import { extractDna } from './llm.js';
import { getPreset, listPresets, buildExtractPrompt, mapCnToEn } from './dnaPresets.js';
import {
  renderDnaPrompt, renderDnaPromptWithOverrides, generateImage, saveStudioImage,
} from './image.js';
import { calcPoints, deductPoints } from './points.js';
import { listModels } from './registry.js';

// v0.2.0: 记忆遗忘——归档 90 天前的变体；每模板只保留最新 50 条未归档
export function runArchive() {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const r1 = db.prepare('UPDATE dna_generations SET archived=1 WHERE archived=0 AND created_at < ?').run(cutoff);
  let n2 = 0;
  const tplIds = db.prepare('SELECT DISTINCT template_id FROM dna_generations WHERE archived=0').all();
  for (const { template_id } of tplIds) {
    const ids = db.prepare('SELECT id FROM dna_generations WHERE template_id=? AND archived=0 ORDER BY id DESC LIMIT -1 OFFSET 50')
      .all(template_id).map((r) => r.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      n2 += db.prepare(`UPDATE dna_generations SET archived=1 WHERE id IN (${ph})`).run(...ids).changes;
    }
  }
  return { by_age: r1.changes, by_count: n2 };
}

// P4: 发散批次归档——90 天前的批次自动 archived（与记忆遗忘同规则）
export function runExploreArchive() {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const r = db.prepare('UPDATE exploration_batches SET archived=1 WHERE archived=0 AND created_at < ?').run(cutoff);
  return { by_age: r.changes };
}

export function mountStudioRoutes(app) {  const db = getDb();
  const cfg = getConfig();
  const uidOf = (req) => (req && req.userId) || 'local';
  const requestApiKey = (req) => {
    const h = req.headers['x-openrouter-key'];
    return typeof h === 'string' ? h.trim() : '';
  };
  const getTemplate = (id, req) => {
    const uid = uidOf(req);
    return cfg.multiUser
      ? db.prepare('SELECT * FROM style_dna_templates WHERE id=? AND user_id=?').get(id, uid)
      : db.prepare('SELECT * FROM style_dna_templates WHERE id=?').get(id);
  };
  const requireAdmin = (req, res) => {
    if (!cfg.multiUser) return true;
    const uid = req.userId;
    if (!uid) { res.status(401).json({ error: '未登录' }); return false; }
    const row = db.prepare('SELECT is_admin FROM users WHERE id=?').get(uid);
    if (!row || !row.is_admin) { res.status(403).json({ error: '需要管理员权限' }); return false; }
    return true;
  };

  // 生成图静态服务（仅 studio 目录）
  const studioDir = path.join(cfg.dataDir || './data', 'uploads', 'studio');
  fs.mkdirSync(studioDir, { recursive: true });
  app.use('/uploads/studio', express.static(studioDir));

  // ---------- DNA 提取 ----------
  // GET /api/studio/vision-models → 启用且支持视觉的聊天模型（公开信息，无密钥）
  app.get('/api/studio/vision-models', ah(async (req, res) => {
    const ms = listModels({ kind: 'chat' })
      .filter((m) => m.extra && m.extra.vision)
      .map((m) => ({ id: m.id, model_id: m.model_id, name: m.name, provider_name: m.provider_name }));
    res.json({ ok: true, models: ms });
  }));
  // P5: GET /api/studio/dna-presets → 启用的类目预设（id/name/fields，供克隆+发散下拉）
  app.get('/api/studio/dna-presets', ah(async (req, res) => {
    const presets = listPresets(true).map((p) => ({ id: p.id, name: p.name, fields: p.fields }));
    res.json({ ok: true, presets });
  }));
  // POST /api/studio/dna/extract { imageBase64, mimeType?, model?, preset_id } → { dna, preset_id }
  // P5: preset_id 必填（废弃旧 11 字段）；按预设提示词提取，中文 key 映射回英文 key 返回
  app.post('/api/studio/dna/extract', ah(async (req, res) => {
    const uid = uidOf(req);
    const { imageBase64, mimeType, model, preset_id } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') return res.status(400).json({ error: '缺少图片数据' });
    if (imageBase64.length > 20 * 1024 * 1024) return res.status(400).json({ error: '图片过大（base64 限 20MB）' });
    const preset = getPreset(preset_id);
    if (!preset || !preset.is_active) return res.status(400).json({ error: '请选择服装类目' });
    const creds = llmCreds(req, cfg, requestApiKey);
    let useModel = String(model || '').trim();
    if (!useModel) {
      const vm = listModels({ kind: 'chat' }).find((m) => m.extra && m.extra.vision);
      useModel = vm ? vm.model_id : '';
    }
    if (!useModel) return res.status(400).json({ error: '请先在模型管理里上架支持视觉的聊天模型，并勾选「支持视觉识图」' });
    const systemPrompt = buildExtractPrompt(preset);
    const raw = await extractDna({
      imageBase64, mimeType: mimeType || 'image/jpeg',
      model: useModel, apiKey: creds.apiKey, baseUrl: creds.baseUrl, provider: creds.provider,
      systemPrompt,
      onUsage: (usage) => {
        try {
          const pts = calcPoints(useModel, usage);
          if (pts > 0) deductPoints(uid, pts, 'studio_dna_extract', null, null, { model: useModel, tokensInput: usage.input, tokensOutput: usage.output });
        } catch { /* 计费失败不影响主流程 */ }
      },
    });
    if (!raw) return res.status(502).json({ error: 'DNA 提取失败，请重试或手动填写' });
    const dna = mapCnToEn(preset, raw);
    res.json({ ok: true, dna, preset_id: preset.id, preset_name: preset.name, fields: preset.fields });
  }));

  // ---------- 模板 ----------
  // POST /api/studio/templates { name, source_image_path?, category?, preset_id?, dna_json, gen_params_json? }
  app.post('/api/studio/templates', ah(async (req, res) => {
    const uid = uidOf(req);
    const { name, source_image_path, source_image_base64, category, preset_id, dna_json, gen_params_json } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: '模板名称必填' });
    if (!dna_json || typeof dna_json !== 'object') return res.status(400).json({ error: 'dna_json 必填' });
    let srcPath = source_image_path || '';
    if (source_image_base64 && typeof source_image_base64 === 'string') {
      try {
        const files = await saveStudioImage(source_image_base64, `src_${Date.now()}.jpg`);
        srcPath = files.image_path;
      } catch { /* 来源图落盘失败不阻塞建模板 */ }
    }
    const now = new Date().toISOString();
    const r = db.prepare(`INSERT INTO style_dna_templates(user_id,name,source_image_path,category,preset_id,dna_json,gen_params_json,status,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?, 'draft',1,?,?)`).run(
      uid, String(name).trim(), srcPath, category || '', preset_id || '',
      JSON.stringify(dna_json), JSON.stringify(gen_params_json || {}), now, now);
    res.json({ ok: true, id: r.lastInsertRowid });
  }));

  // GET /api/studio/templates → 列表（含生成数量、最新缩略图）
  app.get('/api/studio/templates', ah(async (req, res) => {
    const uid = uidOf(req);
    const rows = cfg.multiUser
      ? db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM dna_generations g WHERE g.template_id=t.id) AS gen_count,
          (SELECT thumb_path FROM dna_generations g WHERE g.template_id=t.id ORDER BY id DESC LIMIT 1) AS last_thumb
        FROM style_dna_templates t WHERE t.user_id=? ORDER BY t.updated_at DESC`).all(uid)
      : db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM dna_generations g WHERE g.template_id=t.id) AS gen_count,
          (SELECT thumb_path FROM dna_generations g WHERE g.template_id=t.id ORDER BY id DESC LIMIT 1) AS last_thumb
        FROM style_dna_templates t ORDER BY t.updated_at DESC`).all();
    res.json({ ok: true, templates: rows });
  }));

  // GET /api/studio/templates/:id → 详情
  app.get('/api/studio/templates/:id', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    res.json({ ok: true, template: t });
  }));

  // PUT /api/studio/templates/:id { name?, category?, preset_id?, dna_json?, gen_params_json? }；定稿后 403；version+1
  app.put('/api/studio/templates/:id', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    if (t.status === 'final') return res.status(403).json({ error: '已定稿的模板不可修改 DNA，请先解锁定' });
    const { name, category, preset_id, dna_json, gen_params_json } = req.body || {};
    const now = new Date().toISOString();
    db.prepare(`UPDATE style_dna_templates SET name=?, category=?, preset_id=?, dna_json=?, gen_params_json=?, version=version+1, updated_at=? WHERE id=?`)
      .run(
        name != null ? String(name).trim() : t.name,
        category != null ? category : t.category,
        preset_id != null ? preset_id : (t.preset_id || ''),
        dna_json != null ? JSON.stringify(dna_json) : t.dna_json,
        gen_params_json != null ? JSON.stringify(gen_params_json) : t.gen_params_json,
        now, t.id);
    res.json({ ok: true });
  }));

  // POST /api/studio/templates/:id/finalize → 定稿（锁定 DNA）；/unfinalize → 解锁定
  const setStatus = (status) => ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    db.prepare('UPDATE style_dna_templates SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), t.id);
    res.json({ ok: true, status });
  });
  app.post('/api/studio/templates/:id/finalize', setStatus('final'));
  app.post('/api/studio/templates/:id/unfinalize', setStatus('draft'));

  // ---------- 生成 ----------
  async function doGenerate({ req, template, op, changes, modelId, size, seed, sourceImageBase64 }) {
    const uid = uidOf(req);
    const dna = JSON.parse(template.dna_json || '{}');
    const prompt = changes ? renderDnaPromptWithOverrides(dna, changes) : renderDnaPrompt(dna);
    const genParams = JSON.parse(template.gen_params_json || '{}');
    const useModel = modelId || genParams.model_id;
    const useSize = size || genParams.size || '1024x1024';
    if (!useModel) throw new Error('未选择图片模型（模板未绑定且未指定）');
    const result = await generateImage({ userId: uid, modelId: useModel, prompt, size: useSize, seed, sourceImageBase64 });
    const files = await saveStudioImage(result.imageBase64, `t${template.id}_${Date.now()}.jpg`);
    const now = new Date().toISOString();
    const r = db.prepare(`INSERT INTO dna_generations(template_id,user_id,image_path,thumb_path,prompt_snapshot,seed,model_id,size,op,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      template.id, uid, files.image_path, files.thumb_path, prompt, result.seed, result.model, useSize, op, now);
    db.prepare('UPDATE style_dna_templates SET version=version+1, updated_at=? WHERE id=?').run(now, template.id);
    return { id: r.lastInsertRowid, ...files, seed: result.seed, model: result.model, size: useSize, op, price: result.price, prompt };
  }

  // POST /api/studio/templates/:id/generate { model_id?, size?, seed? } → 一键生图（文生图）
  app.post('/api/studio/templates/:id/generate', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    const { model_id, size, seed } = req.body || {};
    try {
      const g = await doGenerate({ req, template: t, op: 'create', modelId: model_id, size, seed });
      res.json({ ok: true, generation: g });
    } catch (e) {
      res.status(502).json({ error: e.message || '生图失败' });
    }
  }));

  // POST /api/studio/templates/:id/variant { op, changes?, model_id?, size?, seed_mode?, source_generation_id? }
  app.post('/api/studio/templates/:id/variant', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    const { op, changes, model_id, size, seed_mode, source_generation_id } = req.body || {};
    const validOps = ['recolor', 'detail_modify', 'detail_shot', 'scene', 'variant'];
    if (!validOps.includes(op)) return res.status(400).json({ error: 'op 非法' });
    let seed;
    let sourceImageBase64 = null;
    if (source_generation_id) {
      const uid = uidOf(req);
      const src = cfg.multiUser
        ? db.prepare('SELECT * FROM dna_generations WHERE id=? AND user_id=?').get(source_generation_id, uid)
        : db.prepare('SELECT * FROM dna_generations WHERE id=?').get(source_generation_id);
      if (!src) return res.status(404).json({ error: '底图记录不存在' });
      const abs = path.join(cfg.dataDir || './data', src.image_path);
      if (fs.existsSync(abs)) {
        sourceImageBase64 = fs.readFileSync(abs).toString('base64');
        if (seed_mode !== 'new') seed = src.seed;
      }
      // 底图文件丢失 → 退化为文生图同 seed（seed 已取到则用之）
    }
    try {
      const g = await doGenerate({ req, template: t, op, changes, modelId: model_id, size, seed, sourceImageBase64 });
      res.json({ ok: true, generation: g });
    } catch (e) {
      res.status(502).json({ error: e.message || '变体生成失败' });
    }
  }));

  // ---------- 历史与审美评价 ----------
  // GET /api/studio/templates/:id/history?include_archived=1
  app.get('/api/studio/templates/:id/history', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t) return res.status(404).json({ error: '模板不存在' });
    const uid = uidOf(req);
    const inc = req.query && req.query.include_archived === '1';
    const conds = ['template_id=?'];
    const args = [t.id];
    if (cfg.multiUser) { conds.push('user_id=?'); args.push(uid); }
    if (!inc) conds.push('archived=0');
    const rows = db.prepare(`SELECT * FROM dna_generations WHERE ${conds.join(' AND ')} ORDER BY id DESC`).all(...args);
    res.json({ ok: true, generations: rows });
  }));

  // POST /api/studio/generations/:id/rate { rating: liked|deleted }；deleted 同时清文件（DB 留负反馈）
  app.post('/api/studio/generations/:id/rate', ah(async (req, res) => {
    const uid = uidOf(req);
    const g = cfg.multiUser
      ? db.prepare('SELECT * FROM dna_generations WHERE id=? AND user_id=?').get(req.params.id, uid)
      : db.prepare('SELECT * FROM dna_generations WHERE id=?').get(req.params.id);
    if (!g) return res.status(404).json({ error: '记录不存在' });
    const { rating } = req.body || {};
    if (!['liked', 'deleted'].includes(rating)) return res.status(400).json({ error: 'rating 非法' });
    const now = new Date().toISOString();
    db.prepare('UPDATE dna_generations SET user_rating=?, rated_at=? WHERE id=?').run(rating, now, g.id);
    if (rating === 'deleted') {
      for (const p of [g.image_path, g.thumb_path]) {
        if (!p) continue;
        const abs = path.join(cfg.dataDir || './data', p);
        try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* 删文件失败不影响评价 */ }
      }
    }
    res.json({ ok: true });
  }));

  // ---------- 资产库 ----------
  // GET /api/studio/assets?template_id=&rating=&page=&limit=
  app.get('/api/studio/assets', ah(async (req, res) => {
    const uid = uidOf(req);
    const { template_id, rating, page, limit } = req.query || {};
    const lim = Math.min(Math.max(parseInt(limit, 10) || 48, 1), 200);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const conds = [];
    const args = [];
    if (cfg.multiUser) { conds.push('g.user_id = ?'); args.push(uid); }
    if (template_id) { conds.push('g.template_id = ?'); args.push(template_id); }
    if (rating === 'liked') conds.push("g.user_rating = 'liked'");
    else if (rating === 'deleted') conds.push("g.user_rating = 'deleted'");
    else if (rating === 'unrated') conds.push("(g.user_rating IS NULL OR g.user_rating = '')");
    conds.push('g.archived=0');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM dna_generations g ${where}`).get(...args).c;
    const rows = db.prepare(
      `SELECT g.*, t.name AS template_name FROM dna_generations g LEFT JOIN style_dna_templates t ON t.id = g.template_id
       ${where} ORDER BY g.id DESC LIMIT ? OFFSET ?`).all(...args, lim, (pg - 1) * lim);
    res.json({ ok: true, total, page: pg, limit: lim, assets: rows });
  }));

  // POST /api/studio/assets/bulk-delete { ids: [] }（≤200）
  app.post('/api/studio/assets/bulk-delete', ah(async (req, res) => {
    const uid = uidOf(req);
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) return res.status(400).json({ error: 'ids 非法（1-200）' });
    const now = new Date().toISOString();
    let n = 0;
    for (const id of ids) {
      const g = cfg.multiUser
        ? db.prepare('SELECT * FROM dna_generations WHERE id=? AND user_id=?').get(id, uid)
        : db.prepare('SELECT * FROM dna_generations WHERE id=?').get(id);
      if (!g) continue;
      db.prepare("UPDATE dna_generations SET user_rating='deleted', rated_at=? WHERE id=?").run(now, g.id);
      for (const p of [g.image_path, g.thumb_path]) {
        if (!p) continue;
        const abs = path.join(cfg.dataDir || './data', p);
        try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* 忽略 */ }
      }
      n++;
    }
    res.json({ ok: true, deleted: n });
  }));
}
