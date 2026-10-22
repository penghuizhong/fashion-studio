import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';
import { getDb } from './db.js';
import { getConfig } from './config.js';
import { ah } from './asyncHandler.js';
import { problem } from './exploreErrors.js';
import { saveStudioImage } from './image.js';
import { localImage } from './styleWorkspace.js';
import { ownedStudioFile } from './studioPreview.js';
import { studioFileExists } from './imageLifecycle.js';

const now = () => new Date().toISOString();
const owner = req => req.userId || 'local';
export function canvasProject(id, req) {
  const row = getDb().prepare('SELECT * FROM canvas_projects WHERE id=? AND user_id=?').get(id, owner(req));
  if (!row) throw problem('CANVAS_NOT_FOUND', '画板不存在', 404);
  return row;
}
function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw problem('CANVAS_TITLE_INVALID', '画板名称需为1～100个字符');
  return value.trim();
}
function projectView(row) {
  const { snapshot_json, ...rest } = row;
  return { ...rest, snapshot: snapshot_json ? JSON.parse(snapshot_json) : null };
}
function assetView(row) {
  return { ...row, src: `/uploads/studio/${row.image_path.slice('uploads/studio/'.length)}`, available: studioFileExists(row.image_path) };
}
export async function registerCanvasAsset(req, files, name, origin) {
  const db = getDb(), uid = owner(req);
  const existing = db.prepare('SELECT * FROM canvas_assets WHERE user_id=? AND image_path=?').get(uid, files.image_path);
  if (existing) return assetView(existing);
  const bytes = fs.readFileSync(localImage(files.image_path));
  const meta = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
  const swapped = [5,6,7,8].includes(meta.orientation);
  const row = { id: crypto.randomUUID(), user_id: uid, name: String(name || '图片').slice(0,100), ...files,
    width: swapped ? meta.height : meta.width, height: swapped ? meta.width : meta.height,
    fingerprint: crypto.createHash('sha256').update(bytes).digest('hex'), origin, created_at: now() };
  // Another request may have imported the same file while metadata was being read.
  db.prepare('INSERT OR IGNORE INTO canvas_assets(id,user_id,name,image_path,thumb_path,width,height,fingerprint,origin,created_at) VALUES(@id,@user_id,@name,@image_path,@thumb_path,@width,@height,@fingerprint,@origin,@created_at)').run(row);
  return assetView(db.prepare('SELECT * FROM canvas_assets WHERE user_id=? AND image_path=?').get(uid, files.image_path));
}
export function validateCanvasSnapshot(snapshot, projectId, req) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.document?.store || !snapshot.document?.schema || typeof snapshot.document.store !== 'object' || Array.isArray(snapshot.document.store)) throw problem('CANVAS_SNAPSHOT_INVALID', '画板快照格式不正确');
  const records = Object.values(snapshot.document.store);
  if (records.length > 10000) throw problem('CANVAS_TOO_LARGE', '画板对象过多，请拆分画板');
  const assets = getDb().prepare('SELECT a.* FROM canvas_assets a JOIN canvas_project_assets p ON p.asset_id=a.id WHERE p.project_id=? AND a.user_id=?').all(projectId, owner(req));
  const allowed = new Set(assets.map(a=>`/${a.image_path}`));
  for (const record of records) {
    if (!record || typeof record !== 'object') throw problem('CANVAS_SNAPSHOT_INVALID', '画板对象格式不正确');
    if (record.typeName === 'asset' && (record.type !== 'image' || !allowed.has(record.props?.src))) throw problem('CANVAS_ASSET_INVALID', '画板图片必须先保存到当前画板');
    if (record.typeName === 'shape' && ['video','embed','bookmark'].includes(record.type)) throw problem('CANVAS_SHAPE_UNSUPPORTED', '暂不支持外部嵌入内容');
  }
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw problem('CANVAS_TOO_LARGE', '画板快照超过8MB，请拆分画板');
  return json;
}
function publicSnapshot(snapshot) {
  if(!snapshot)return null;
  const store=snapshot.document.store;
  const visible=shape=>{const seen=new Set();let current=shape;while(current?.typeName==='shape'){if(current.meta?.hidden||seen.has(current.id)||seen.size>1000)return false;seen.add(current.id);current=store[current.parentId];}return true;};
  const hiddenIds=Object.entries(store).filter(([,record])=>record.typeName==='shape'&&!visible(record)).map(([id])=>id);
  for(const id of hiddenIds)delete store[id];
  for(const [id,record] of Object.entries(store))if(record.typeName==='binding'&&(!store[record.fromId]||!store[record.toId]))delete store[id];
  const used=new Set(Object.values(store).filter(r=>r.typeName==='shape'&&r.props?.assetId).map(r=>r.props.assetId));
  for(const [id,record] of Object.entries(store))if(record.typeName==='asset'&&!used.has(id))delete store[id];
  return snapshot;
}
export function mountCanvasRoutes(app) {
  app.use('/api/canvas',(req,res,next)=>{
    if(['POST','PUT','PATCH'].includes(req.method)&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)))return res.status(400).json({code:'CANVAS_BODY_INVALID',error:'请提供有效的 JSON 对象'});
    next();
  });
  const shared = token => {
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw problem('CANVAS_SHARE_NOT_FOUND','分享不存在或已过期',404);
    const hash=crypto.createHash('sha256').update(token).digest('hex');
    const row=getDb().prepare('SELECT p.* FROM canvas_shares s JOIN canvas_projects p ON p.id=s.project_id WHERE s.token_hash=? AND s.expires_at>? AND s.user_id=p.user_id').get(hash,Date.now());
    if(!row)throw problem('CANVAS_SHARE_NOT_FOUND','分享不存在或已过期',404);
    return row;
  };
  app.get('/api/canvas/shared/:token',ah(async(req,res)=>{
    const row=shared(req.params.token),view=projectView(row);
    view.snapshot=publicSnapshot(view.snapshot);
    if(view.snapshot){for(const record of Object.values(view.snapshot.document.store)){if(record.typeName!=='asset')continue;const asset=getDb().prepare('SELECT a.id FROM canvas_assets a JOIN canvas_project_assets p ON p.asset_id=a.id WHERE a.id=? AND p.project_id=? AND a.user_id=?').get(record.meta?.canvasAssetId,row.id,row.user_id);record.props.src=asset?`/api/canvas/shared/${req.params.token}/assets/${asset.id}`:'';}}
    res.set('Cache-Control','no-store').json({title:row.title,snapshot:view.snapshot});
  }));
  app.get('/api/canvas/shared/:token/assets/:assetId',ah(async(req,res)=>{
    const project=shared(req.params.token);
    const asset=getDb().prepare('SELECT a.image_path FROM canvas_assets a JOIN canvas_project_assets p ON p.asset_id=a.id WHERE a.id=? AND p.project_id=? AND a.user_id=?').get(req.params.assetId,project.id,project.user_id);
    const store=publicSnapshot(project.snapshot_json?JSON.parse(project.snapshot_json):null)?.document.store||{};
    const visible=Object.values(store).some(r=>r.typeName==='shape'&&r.props?.assetId&&store[r.props.assetId]?.meta?.canvasAssetId===req.params.assetId);
    if(!asset||!visible)throw problem('CANVAS_ASSET_MISSING','图片不存在',404);
    res.set('Cache-Control','no-store').sendFile(localImage(asset.image_path));
  }));
  app.post('/api/canvas/projects/:id/share',ah(async(req,res)=>{
    const project=canvasProject(req.params.id,req),token=crypto.randomBytes(32).toString('base64url'),expiresAt=Date.now()+7*86400000;
    getDb().transaction(()=>{getDb().prepare('DELETE FROM canvas_shares WHERE project_id=? AND user_id=?').run(project.id,owner(req));getDb().prepare('INSERT INTO canvas_shares VALUES(?,?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),project.id,owner(req),expiresAt);})();
    res.status(201).json({token,expiresAt});
  }));
  app.delete('/api/canvas/projects/:id/share',ah(async(req,res)=>{canvasProject(req.params.id,req);getDb().prepare('DELETE FROM canvas_shares WHERE project_id=? AND user_id=?').run(req.params.id,owner(req));res.json({ok:true});}));
  app.get('/api/canvas/brand-kits',ah(async(req,res)=>res.json({kits:getDb().prepare('SELECT id,name,definition_json FROM canvas_brand_kits WHERE user_id=? ORDER BY updated_at DESC').all(owner(req)).map(({definition_json,...row})=>({...row,...JSON.parse(definition_json)}))})));
  app.post('/api/canvas/brand-kits',ah(async(req,res)=>{
    const name=title(req.body.name),prompt=req.body.prompt,palette=req.body.palette;
    if(typeof prompt!=='string'||prompt.length>2000||!Array.isArray(palette)||palette.length>8||palette.some(c=>typeof c!=='string'||!/^#[0-9a-f]{6}$/i.test(c)))throw problem('CANVAS_BRAND_INVALID','品牌描述最多2000字，色板最多8个六位十六进制色值');
    const id=crypto.randomUUID();getDb().prepare('INSERT INTO canvas_brand_kits VALUES(?,?,?,?,?)').run(id,owner(req),name,JSON.stringify({prompt,palette}),now());res.status(201).json({id,name,prompt,palette});
  }));
  app.delete('/api/canvas/brand-kits/:id',ah(async(req,res)=>{if(!getDb().prepare('DELETE FROM canvas_brand_kits WHERE id=? AND user_id=?').run(req.params.id,owner(req)).changes)throw problem('CANVAS_BRAND_NOT_FOUND','品牌套件不存在',404);res.json({ok:true});}));
  app.get('/api/canvas/assets',ah(async(req,res)=>{
    const search=String(req.query.search||'').slice(0,100);
    const rows=getDb().prepare("SELECT * FROM canvas_assets WHERE user_id=? AND name LIKE ? ORDER BY created_at DESC LIMIT 100").all(owner(req),`%${search}%`);
    res.json({assets:rows.map(assetView).filter(a=>a.available)});
  }));
  app.post('/api/canvas/assets/:assetId/model',ah(async(req,res)=>{
    const db=getDb(),asset=db.prepare('SELECT * FROM canvas_assets WHERE id=? AND user_id=?').get(req.params.assetId,owner(req));
    if(!asset||!studioFileExists(asset.image_path))throw problem('CANVAS_ASSET_MISSING','图片不存在',404);
    const reference=db.prepare('SELECT id FROM style_references WHERE user_id=? AND image_path=?').get(owner(req),asset.image_path);
    if(reference)db.prepare("UPDATE style_references SET kind='model' WHERE id=? AND user_id=?").run(reference.id,owner(req));
    else db.prepare("INSERT INTO style_references(user_id,image_path,thumb_path,created_at,name,kind) VALUES(?,?,?,?,?,'model')").run(owner(req),asset.image_path,asset.thumb_path,now(),asset.name);
    res.json({ok:true});
  }));
  app.get('/api/canvas/projects', (req,res)=>res.json({ projects: getDb().prepare('SELECT id,title,revision,created_at,updated_at FROM canvas_projects WHERE user_id=? ORDER BY updated_at DESC,id DESC').all(owner(req)) }));
  app.post('/api/canvas/projects', ah(async(req,res)=>{
    const id = crypto.randomUUID(), stamp = now();
    getDb().prepare('INSERT INTO canvas_projects(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,owner(req),title(req.body.title || '未命名画板'),stamp,stamp);
    res.status(201).json({ project: projectView(canvasProject(id,req)) });
  }));
  app.get('/api/canvas/projects/:id', ah(async(req,res)=>{
    const project = canvasProject(req.params.id,req);
    const assets = getDb().prepare('SELECT a.* FROM canvas_assets a JOIN canvas_project_assets p ON p.asset_id=a.id WHERE p.project_id=? AND a.user_id=?').all(project.id,owner(req));
    res.json({ project: projectView(project), assets: assets.map(assetView) });
  }));
  app.put('/api/canvas/projects/:id', ah(async(req,res)=>{
    canvasProject(req.params.id,req);
    const revision = req.body.expectedRevision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw problem('CANVAS_REVISION_REQUIRED', '请提供画板版本号');
    const name = title(req.body.title), json = validateCanvasSnapshot(req.body.snapshot,req.params.id,req);
    const result = getDb().prepare('UPDATE canvas_projects SET title=?,snapshot_json=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?').run(name,json,now(),req.params.id,owner(req),revision);
    if (!result.changes) throw problem('CANVAS_REVISION_CONFLICT', '画板已在其他窗口更新，本地修改已保留，请另存或加载远端版本',409);
    res.json({ revision: revision+1 });
  }));
  app.post('/api/canvas/projects/:id/assets', ah(async(req,res)=>{
    const project = canvasProject(req.params.id,req);
    let files, origin;
    if (req.body.assetId) {
      const existing = getDb().prepare('SELECT * FROM canvas_assets WHERE id=? AND user_id=?').get(req.body.assetId,owner(req));
      if (!existing || !studioFileExists(existing.image_path)) throw problem('CANVAS_ASSET_MISSING','图片不存在',404);
      getDb().prepare('INSERT OR IGNORE INTO canvas_project_assets VALUES(?,?)').run(project.id,existing.id);
      return res.json({ asset: assetView(existing) });
    }
    if (req.body.imageBase64) {
      const data = req.body.imageBase64;
      if (typeof data !== 'string' || data.length > 28*1024*1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw problem('INVALID_IMAGE','请上传不超过20MB的位图');
      try { files = await saveStudioImage(data,`canvas-${crypto.randomUUID()}`); } catch(e) { if(/Input buffer|unsupported image|pixel limit|corrupt|bad seek|Premature/i.test(e.message))throw problem('INVALID_IMAGE','图片内容无效或尺寸过大，请换一张位图');throw e; } origin='upload';
    } else {
      const file = req.body.path;
      if (typeof file !== 'string' || !studioFileExists(file) || !ownedStudioFile(file,owner(req))) throw problem('CANVAS_ASSET_MISSING','参考图片不存在',404);
      files = { image_path:file, thumb_path:file }; origin='library';
    }
    const asset = await registerCanvasAsset(req,files,req.body.name,origin);
    getDb().prepare('INSERT OR IGNORE INTO canvas_project_assets VALUES(?,?)').run(project.id,asset.id);
    res.status(201).json({ asset });
  }));
}
