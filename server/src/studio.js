import { mountStudioLifecycle,lifecycleState,changeLifecycle } from './studioLifecycle.js';
import { imageAvailability,templateAvailability,studioFileExists } from './imageLifecycle.js';
import { randomUUID } from 'node:crypto';
import { problem } from './exploreErrors.js';
import { mountStyleWorkspace } from './styleWorkspace.js';
import { ensureStyle, saveVersion, setWorking, styleVersion, recordStyleImage } from './styleVersions.js';
import { normalizeCamera } from '../../shared/photography.js';
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
import sharp from 'sharp';

// P6: 服务端兜底压缩——base64 超过约 2MB 时压到最长边 1024px / JPEG 82（防直接调 API 传大图）
export async function shrinkImageIfLarge(base64, mimeType) {
  const approxBytes = Math.floor(base64.length * 0.75);
  if (approxBytes <= 2 * 1024 * 1024) return { base64, mimeType };
  try {
    const buf = Buffer.from(base64, 'base64');
    const out = await sharp(buf)
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { base64: out.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { base64, mimeType }; // 压缩失败就用原图，不阻塞
  }
}
import {
  renderDnaPrompt, renderDnaPromptWithOverrides, generateImage, saveStudioImage,
} from './image.js';
import { calcPoints, deductPoints } from './points.js';
import { listModels, listImageModelsCompat } from './registry.js';

// v0.2.0: 记忆遗忘——归档 90 天前的变体；每模板只保留最新 50 条未归档
export function runArchive() {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const r1 = db.prepare("UPDATE dna_generations SET archived=1,lifecycle='archived' WHERE lifecycle='active' AND archived=0 AND created_at < ?").run(cutoff);
  let n2 = 0;
  const tplIds = db.prepare('SELECT DISTINCT template_id FROM dna_generations WHERE archived=0').all();
  for (const { template_id } of tplIds) {
    const ids = db.prepare('SELECT id FROM dna_generations WHERE template_id=? AND archived=0 ORDER BY id DESC LIMIT -1 OFFSET 50')
      .all(template_id).map((r) => r.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      n2 += db.prepare(`UPDATE dna_generations SET archived=1,lifecycle='archived' WHERE lifecycle='active' AND id IN (${ph})`).run(...ids).changes;
    }
  }
  return { by_age: r1.changes, by_count: n2 };
}

// P4: 发散批次归档——90 天前的批次自动 archived（与记忆遗忘同规则）
export function runExploreArchive() {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const r = db.prepare("UPDATE exploration_batches SET archived=1,lifecycle='archived' WHERE lifecycle='active' AND archived=0 AND created_at < ?").run(cutoff);
  return { by_age: r.changes };
}

export function mountStudioRoutes(app) {  const db = getDb();
  mountStudioLifecycle(app);
  mountStyleWorkspace(app);
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
  app.use('/uploads/studio', (req,res,next)=>{
    if(!cfg.multiUser)return next();
    if(!req.userId)return res.status(401).json({error:'未登录'});
    let file;
    try{file=path.posix.normalize('uploads/studio'+decodeURIComponent(req.path));}catch{return res.status(400).end();}
    if(!file.startsWith('uploads/studio/'))return res.status(404).end();
    const uid=req.userId;
    const owned=db.prepare(`SELECT 1 FROM dna_generations WHERE user_id=? AND (image_path=? OR thumb_path=?)
      UNION ALL SELECT 1 FROM style_dna_templates WHERE user_id=? AND (source_image_path=? OR source_thumb_path=?)
      UNION ALL SELECT 1 FROM exploration_batches b,json_each(b.renders_json) r WHERE b.user_id=? AND (json_extract(r.value,'$.image_path')=? OR json_extract(r.value,'$.thumb_path')=?)
      UNION ALL SELECT 1 FROM style_references WHERE user_id=? AND (image_path=? OR thumb_path=?)
      UNION ALL SELECT 1 FROM explore_items i JOIN explore_jobs j ON j.id=i.job_id WHERE j.user_id=? AND (json_extract(i.result_json,'$.image_path')=? OR json_extract(i.result_json,'$.thumb_path')=?) LIMIT 1`)
      .get(uid,file,file,uid,file,file,uid,file,file,uid,file,file,uid,file,file);
    if(!owned)return res.status(404).end();
    next();
  },ah(async(req,res,next)=>{
    if(req.query.download!=='1')return next();
    const file=path.resolve(studioDir,'.'+decodeURIComponent(req.path));
    if(!file.startsWith(path.resolve(studioDir)+path.sep))return res.status(404).end();
    let metadata;
    try{metadata=await sharp(file).metadata();}catch{return res.status(404).end();}
    const extension=metadata.format==='jpeg'?'jpg':metadata.format;
    res.setHeader('Cache-Control','private, no-store');
    res.type(extension);
    // Header fixes legacy files whose .jpg name actually contains PNG/WebP bytes.
    res.download(file,`${path.parse(file).name}.${extension}`);
  }),express.static(studioDir,{setHeaders:res=>{if(cfg.multiUser)res.setHeader('Cache-Control','private, no-store');}}));

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
    // P6: 大图服务端兜底压缩（前端已压过，这里只处理直接调 API 的情况）
    const shrunk = await shrinkImageIfLarge(imageBase64, mimeType || 'image/jpeg');
    const raw = await extractDna({
      imageBase64: shrunk.base64, mimeType: shrunk.mimeType,
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
    if(source_image_path!=null && typeof source_image_path!=='string')throw problem('INVALID_SOURCE_IMAGE','来源路径格式不正确');
    if(source_image_base64!=null && (typeof source_image_base64!=='string'||source_image_base64.length>20*1024*1024))throw problem('INVALID_SOURCE_IMAGE','参考原图格式不正确或超过 15MB');
    const hasSourceData=typeof source_image_base64==='string' && source_image_base64.length>0;
    let srcPath = source_image_path || '';
    if(srcPath && !hasSourceData){const owned=db.prepare('SELECT 1 FROM dna_generations WHERE user_id=? AND image_path=? UNION ALL SELECT 1 FROM style_dna_templates WHERE user_id=? AND source_image_path=? LIMIT 1').get(uid,srcPath,uid,srcPath);if(!owned)throw problem('SOURCE_NOT_OWNED','来源图片不存在',404);}
    let srcThumb = '';
    if (source_image_base64 && typeof source_image_base64 === 'string') {
      try {
        const files = await saveStudioImage(source_image_base64, `src_${randomUUID()}.jpg`);
        srcPath = files.image_path;
        srcThumb = files.thumb_path; // P7: 来源图缩略图，卡片预览用
      } catch { throw problem('INVALID_SOURCE_IMAGE','原始参考图保存失败，请选择有效的位图重试'); }
    }
    const now = new Date().toISOString();
    const r = db.transaction(()=>{
      if(srcPath&&!studioFileExists(srcPath))throw problem('SOURCE_MISSING','原始图片已失效，请重新选择',404);
      return db.prepare(`INSERT INTO style_dna_templates(user_id,name,source_image_path,source_thumb_path,category,preset_id,dna_json,gen_params_json,status,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?, 'draft',1,?,?)`).run(uid,String(name).trim(),srcPath,srcThumb,category||'',preset_id||'',JSON.stringify(dna_json),JSON.stringify(gen_params_json||{}),now,now);
    }).immediate();
    res.json({ ok: true, id: r.lastInsertRowid });
  }));

  // GET /api/studio/templates → 列表（含生成数量、最新缩略图）
  app.get('/api/studio/templates', ah(async (req, res) => {
    const uid = uidOf(req);
    for(const t of (cfg.multiUser?db.prepare('SELECT * FROM style_dna_templates WHERE user_id=?').all(uid):db.prepare('SELECT * FROM style_dna_templates').all())) ensureStyle(t);
    const rows = cfg.multiUser
      ? db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM dna_generations g WHERE g.template_id=t.id) AS gen_count,
          (SELECT thumb_path FROM dna_generations g WHERE g.id=t.cover_generation_id AND COALESCE(g.user_rating,'')!='deleted') AS last_thumb,
          (SELECT image_path FROM dna_generations g WHERE g.id=t.cover_generation_id AND COALESCE(g.user_rating,'')!='deleted') AS last_image
        FROM style_dna_templates t WHERE t.user_id=? ORDER BY t.updated_at DESC`).all(uid)
      : db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM dna_generations g WHERE g.template_id=t.id) AS gen_count,
          (SELECT thumb_path FROM dna_generations g WHERE g.id=t.cover_generation_id AND COALESCE(g.user_rating,'')!='deleted') AS last_thumb,
          (SELECT image_path FROM dna_generations g WHERE g.id=t.cover_generation_id AND COALESCE(g.user_rating,'')!='deleted') AS last_image
        FROM style_dna_templates t ORDER BY t.updated_at DESC`).all();
    res.json({ ok: true, templates: rows.filter(t=>t.lifecycle===lifecycleState(req.query.state)).map(templateAvailability) });
  }));

  // GET /api/studio/templates/:id → 详情
  app.get('/api/studio/templates/:id', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t || t.lifecycle==='deleted') return res.status(404).json({ error: '模板不存在' });
    res.json({ ok: true, template: t });
  }));

  // PUT /api/studio/templates/:id { name?, category?, preset_id?, dna_json?, gen_params_json? }；定稿后 403；version+1
  app.put('/api/studio/templates/:id', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t || t.lifecycle==='deleted') return res.status(404).json({ error: '模板不存在' });
    if (t.status === 'final' && (req.body.dna_json || req.body.category || req.body.preset_id)) return res.status(403).json({ error: '已定稿的模板不可修改 DNA，请先解锁定' });
    const { name, category, preset_id, dna_json, gen_params_json } = req.body || {};
    if((preset_id!=null && preset_id!==(t.preset_id||''))||(category!=null && category!==t.category))throw problem('VERSION_SCHEMA_CONFLICT','类目变更请另存款式，不能混用已有设计版本的字段');
    const versioned=ensureStyle(t);
    if(dna_json){const v=saveVersion(versioned,{dna:dna_json,parent_id:versioned.work_version_id,request_key:req.body.request_key||randomUUID()});setWorking(versioned,v.id);}
    const now = new Date().toISOString();
    db.prepare(`UPDATE style_dna_templates SET name=?, category=?, preset_id=?, dna_json=?, gen_params_json=?, version=version+1, updated_at=? WHERE id=?`)
      .run(
        name != null ? String(name).trim() : t.name,
        category != null ? category : t.category,
        preset_id != null ? preset_id : (t.preset_id || ''),
        dna_json != null ? styleVersion(versioned,db.prepare('SELECT work_version_id FROM style_dna_templates WHERE id=?').get(t.id).work_version_id).dna_json : t.dna_json,
        gen_params_json != null ? JSON.stringify(gen_params_json) : t.gen_params_json,
        now, t.id);
    res.json({ ok: true });
  }));

  // POST /api/studio/templates/:id/finalize → 定稿（锁定 DNA）；/unfinalize → 解锁定
  const setStatus = (status) => ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t || t.lifecycle==='deleted') return res.status(404).json({ error: '模板不存在' });
    db.prepare('UPDATE style_dna_templates SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), t.id);
    res.json({ ok: true, status });
  });
  app.post('/api/studio/templates/:id/finalize', setStatus('final'));
  app.post('/api/studio/templates/:id/unfinalize', setStatus('draft'));

  // ---------- 生成 ----------
  async function doGenerate({ req, template, op, changes, modelId, size, seed, sourceImageBase64, camera }) {
    const uid = uidOf(req);
    const dna = JSON.parse(template.dna_json || '{}');
    const merged=changes?Object.fromEntries(Object.entries({...dna,...Object.fromEntries(Object.entries(changes).map(([k,value])=>[k,{value,confidence:1}]))})):dna;
    const prompt = renderDnaPrompt({dna:merged,presetId:template.preset_id,camera:normalizeCamera(camera)});
    const genParams = JSON.parse(template.gen_params_json || '{}');
    // 模型优先级：请求指定 > 模板绑定 > 第一个可用图片模型
    let useModel = modelId || genParams.model_id;
    if (!useModel) {
      const avail = listImageModelsCompat(true);
      if (!avail.length) {
        const e = new Error('暂无可用的图片模型，请先在模型管理里上架图片模型');
        e.statusCode = 400;
        throw e;
      }
      useModel = avail[0].id;
    }
    const useSize = size || genParams.size || '1024x1024';
    const result = await generateImage({ userId: uid, modelId: useModel, prompt, size: useSize, seed, sourceImageBase64 });
    const files = await saveStudioImage(result.imageBase64, `t${template.id}_${Date.now()}.jpg`);
    const now = new Date().toISOString();
    const versioned=ensureStyle(template),version=styleVersion(versioned,versioned.work_version_id);
    const generationId=recordStyleImage({template_id:template.id,user_id:uid,version_id:version.id,op,camera:normalizeCamera(camera),legacy:true}, {...files,prompt_snapshot:prompt,seed:result.seed,model:result.model,size:useSize},`legacy_${randomUUID()}`);
    db.prepare('UPDATE style_dna_templates SET version=version+1, updated_at=? WHERE id=?').run(now, template.id);
    return { id: generationId, ...files, seed: result.seed, model: result.model, size: useSize, op, price: result.price, prompt };
  }

  // POST /api/studio/templates/:id/generate { model_id?, size?, seed? } → 一键生图（文生图）
  app.post('/api/studio/templates/:id/generate', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if(t&&t.lifecycle!=='active')throw problem('RESTORE_REQUIRED','请先恢复款式再生成',409);
    if (!t || t.lifecycle==='deleted') return res.status(404).json({ error: '模板不存在' });
    const { model_id, size, seed } = req.body || {};
    try {
      const g = await doGenerate({ req, template: t, op: 'create', modelId: model_id, size, seed, camera:req.body.camera });
      res.json({ ok: true, generation: g });
    } catch (e) {
      res.status(502).json({ error: e.message || '生图失败' });
    }
  }));

  // POST /api/studio/templates/:id/variant { op, changes?, model_id?, size?, seed_mode?, source_generation_id? }
  app.post('/api/studio/templates/:id/variant', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if(t&&t.lifecycle!=='active')throw problem('RESTORE_REQUIRED','请先恢复款式再生成',409);
    if (!t || t.lifecycle==='deleted') return res.status(404).json({ error: '模板不存在' });
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
      if (!src || src.template_id!==t.id || src.user_rating==='deleted') return res.status(404).json({ error: '底图记录不存在' });
      const abs = path.join(cfg.dataDir || './data', src.image_path);
      if (fs.existsSync(abs)) {
        sourceImageBase64 = fs.readFileSync(abs).toString('base64');
        if (seed_mode !== 'new') seed = src.seed;
      }
      if(!sourceImageBase64) return res.status(404).json({error:'底图文件不存在，请重新选择'});
    }
    try {
      const g = await doGenerate({ req, template: t, op, changes, modelId: model_id, size, seed, sourceImageBase64, camera:req.body.camera });
      res.json({ ok: true, generation: g });
    } catch (e) {
      res.status(502).json({ error: e.message || '变体生成失败' });
    }
  }));

  // ---------- 历史与审美评价 ----------
  // GET /api/studio/templates/:id/history?include_archived=1
  app.get('/api/studio/templates/:id/history', ah(async (req, res) => {
    const t = getTemplate(req.params.id, req);
    if (!t || t.lifecycle==='deleted') return res.status(404).json({ error: '模板不存在' });
    const uid = uidOf(req);
    const inc = req.query && req.query.include_archived === '1';
    const conds = ['template_id=?'];
    const args = [t.id];
    if (cfg.multiUser) { conds.push('user_id=?'); args.push(uid); }
    if (!inc) conds.push('archived=0');
    const rows = db.prepare(`SELECT * FROM dna_generations WHERE ${conds.join(' AND ')} ORDER BY id DESC`).all(...args);
    res.json({ ok: true, generations: rows.filter(g=>!(['trash','deleted'].includes(g.lifecycle))).map(imageAvailability) });
  }));

  // POST /api/studio/generations/:id/rate { rating: liked|deleted }；deleted 兼容为归档，保留被版本引用的原文件
  app.post('/api/studio/generations/:id/rate', ah(async (req, res) => {
    const uid = uidOf(req);
    const g = cfg.multiUser
      ? db.prepare('SELECT * FROM dna_generations WHERE id=? AND user_id=?').get(req.params.id, uid)
      : db.prepare('SELECT * FROM dna_generations WHERE id=?').get(req.params.id);
    if (!g) return res.status(404).json({ error: '记录不存在' });
    const { rating } = req.body || {};
    if (!['liked', 'deleted'].includes(rating)) return res.status(400).json({ error: 'rating 非法' });
    const now = new Date().toISOString();
    if(rating==='deleted') changeLifecycle('generations',g.id,req,'archive');
    else db.prepare('UPDATE dna_generations SET user_rating=?,rated_at=? WHERE id=?').run(rating,now,g.id);
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
    conds.push('g.lifecycle=?');args.push(lifecycleState(req.query.state || (rating==='archived'?'archived':'active')));
    if(!req.query.template_id && lifecycleState(req.query.state)==='active')conds.push("t.lifecycle='active'");
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM dna_generations g LEFT JOIN style_dna_templates t ON t.id=g.template_id ${where}`).get(...args).c;
    const rows = db.prepare(
      `SELECT g.*, t.name AS template_name FROM dna_generations g LEFT JOIN style_dna_templates t ON t.id = g.template_id
       ${where} ORDER BY g.id DESC LIMIT ? OFFSET ?`).all(...args, lim, (pg - 1) * lim);
    res.json({ ok: true, total, page: pg, limit: lim, assets: rows.map(imageAvailability) });
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
      changeLifecycle('generations',g.id,req,'archive');
      n++;
    }
    res.json({ ok: true, deleted: n });
  }));
}
