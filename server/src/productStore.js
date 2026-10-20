import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDb} from './db.js';
import {getConfig} from './config.js';
import {problem} from './exploreErrors.js';
import {ownedStudioFile} from './studioPreview.js';
import {productFileOwned} from './productReferences.js';
import {canonical} from './styleVersions.js';
export const stamp=()=>new Date().toISOString();
export const owner=req=>req.userId||'local';
export const libraryKinds=['knowledge','standard','size_table','grading'];
export const kinds=['project','delivery','views',...libraryKinds,'body','pattern','quote','sample','issue','production','calculation'];
export const fail=(message,code='INVALID_PRODUCT_DATA',status=400)=>{throw problem(code,message,status);};
export const isAdmin=req=>!getConfig().multiUser||!!getDb().prepare('SELECT is_admin FROM users WHERE id=?').get(owner(req))?.is_admin;
export const requireAdmin=req=>{if(!isAdmin(req))fail('仅维护人员可发布标准资料','FORBIDDEN',403);};
export function object(value,label='资料') {if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>300000)fail(`${label}格式无效或内容过长`);return value;}
export function text(value,label,max=1000,required=false){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))fail(`${label}${required?'不能为空且':''}长度最多${max}字`);return value.trim();}
export function list(value,label,max=100){if(!Array.isArray(value)||value.length>max)fail(`${label}数量无效`);return value;}
export function record(row){if(!row)return null;const {payload_json,...rest}=row;return {...rest,data:JSON.parse(payload_json)};}
export function getRecord(id,req,{kind,write=false,published=false}={}){
 const r=record(getDb().prepare('SELECT * FROM product_records WHERE id=?').get(String(id)));
 if(!r||r.lifecycle==='deleted'||(kind&&r.kind!==kind))fail('资料不存在','PRODUCT_NOT_FOUND',404);
 const own=r.user_id===owner(req)||!getConfig().multiUser;
 const publicRead=libraryKinds.includes(r.kind)&&r.state==='published'&&r.lifecycle==='active';
 if(!own&&(!publicRead||write))fail('资料不存在','PRODUCT_NOT_FOUND',404);
 if(published&&(!publicRead||r.data.verified!==true))fail('请先选择已发布且核对过的标准资料');
 if(write&&r.lifecycle!=='active')fail('请先恢复资料','RESTORE_REQUIRED',409);
 return r;
}
export const history=(id,req,page=1)=>{
 const r=getRecord(id,req),db=getDb(),limit=20,publicOnly=getConfig().multiUser&&r.user_id!==owner(req);
 const where=publicOnly?"record_id=? AND state='published'":"record_id=?";
 return {items:db.prepare(`SELECT * FROM product_history WHERE ${where} ORDER BY revision DESC LIMIT ? OFFSET ?`).all(id,limit,(page-1)*limit).map(record),total:db.prepare(`SELECT COUNT(*) n FROM product_history WHERE ${where}`).get(id).n,page,limit};
};
export function collectPaths(data){
 const files=new Set();
 const visit=x=>{if(!x||typeof x!=='object')return;for(const [key,value] of Object.entries(x)){
  if(['image_path','thumb_path','path'].includes(key)&&typeof value==='string'&&value.startsWith('uploads/'))files.add(value);
  if(key==='file_id'&&typeof value==='string') {const file=getDb().prepare('SELECT path,thumb_path FROM product_files WHERE id=?').get(value);if(!file)fail('附件不存在','FILE_NOT_FOUND',404);files.add(file.path);if(file.thumb_path)files.add(file.thumb_path);}
  if(value&&typeof value==='object')visit(value);
 }};visit(data);return [...files];
}
export function checkPath(file,req){
 const root=path.resolve(getConfig().dataDir),abs=path.resolve(root,file);
 if(!abs.startsWith(root+path.sep)||!fs.existsSync(abs)||!fs.statSync(abs).isFile())fail('资料文件不存在，请重新选择','SOURCE_MISSING',404);
 const own=file.startsWith('uploads/studio/')?ownedStudioFile(file,owner(req)):productFileOwned(getDb(),file,owner(req));
 if(!own)fail('资料文件不存在','FILE_NOT_FOUND',404);
}
function saveRefs(id,revision,userId,data,req){for(const file of collectPaths(data)){checkPath(file,req);getDb().prepare('INSERT OR IGNORE INTO product_file_refs VALUES(?,?,?,?)').run(id,revision,userId,file);}}
export function createRecord(kind,data,req,{projectId=null,templateId=null,state='draft',id=crypto.randomUUID()}={}){
 if(!kinds.includes(kind))fail('资料类型无效');object(data);
 const db=getDb(),now=stamp();
 db.prepare('INSERT INTO product_records VALUES(?,?,?,?,?,1,\'active\',?,?,?,?)').run(id,owner(req),kind,projectId,templateId,state,canonical(data),now,now);
 db.prepare('INSERT INTO product_history VALUES(?,1,?,?,?,?,?,?)').run(id,owner(req),'create',canonical(data),state,'active',now);
 saveRefs(id,1,owner(req),data,req);return getRecord(id,req);
}
export function revise(r,data,req,{expected=r.revision,state=r.state,lifecycle=r.lifecycle,action='save'}={}){
 object(data);const db=getDb();
 if(expected!==r.revision)fail('资料已被更新，请刷新后重试；本地输入仍保留','PRODUCT_CONFLICT',409);
 if(canonical(data)===canonical(r.data)&&state===r.state&&lifecycle===r.lifecycle)return r;
 const n=r.revision+1,now=stamp();
 const changed=db.prepare('UPDATE product_records SET revision=?,state=?,lifecycle=?,payload_json=?,updated_at=? WHERE id=? AND revision=?').run(n,state,lifecycle,canonical(data),now,r.id,r.revision).changes;
 if(!changed)fail('资料已被更新，请刷新后重试','PRODUCT_CONFLICT',409);
 db.prepare('INSERT INTO product_history VALUES(?,?,?,?,?,?,?,?)').run(r.id,n,owner(req),action,canonical(data),state,lifecycle,now);
 saveRefs(r.id,n,r.user_id,data,req);
 return record(db.prepare('SELECT * FROM product_records WHERE id=?').get(r.id));
}
export function atomic(req,body,action){
 const key=body.request_key;if(!/^[\w-]{8,100}$/.test(key||''))fail('需要有效请求标识');
 const signature=canonical({path:req.originalUrl.split('?')[0],method:req.method,body});
 return getDb().transaction(()=>{
  const prior=getDb().prepare('SELECT * FROM product_requests WHERE user_id=? AND request_key=?').get(owner(req),key);
  if(prior){if(prior.signature!==signature)fail('请求标识已用于其他操作','IDEMPOTENCY_CONFLICT',409);return JSON.parse(prior.result_json);}
  const result=action();getDb().prepare('INSERT INTO product_requests VALUES(?,?,?,?)').run(owner(req),key,signature,JSON.stringify(result));return result;
 }).immediate();
}
export function listRecords(req,{kind,projectId,roundId,category,search='',page=1,state='active'}={}){
 if(!kinds.includes(kind))fail('资料类型无效');if(!['active','archived','trash'].includes(state))fail('资料状态无效');
 const db=getDb(),cond=['kind=?','lifecycle=?'],args=[kind,state],limit=20;
 if(getConfig().multiUser){cond.push(libraryKinds.includes(kind)?"(user_id=? OR (state='published' AND lifecycle='active'))":'user_id=?');args.push(owner(req));}
 if(projectId){getRecord(projectId,req,{kind:'project'});cond.push('project_id=?');args.push(projectId);}
 if(roundId){const round=getRecord(roundId,req,{kind:'sample'});if(projectId&&round.project_id!==projectId)fail('样衣轮次不存在','PRODUCT_NOT_FOUND',404);cond.push("json_extract(payload_json,'$.round_id')=?");args.push(roundId);}
 if(search){cond.push('(json_extract(payload_json,\'$.name\') LIKE ? OR json_extract(payload_json,\'$.category\') LIKE ? OR json_extract(payload_json,\'$.content\') LIKE ?)');const s='%'+String(search).slice(0,100)+'%';args.push(s,s,s);}
 if(category){cond.push("(COALESCE(json_extract(payload_json,'$.category'),'')='' OR json_extract(payload_json,'$.category')=?)");args.push(String(category).slice(0,100));}
 page=Math.max(1,parseInt(page)||1);const where=cond.join(' AND ');
 return {items:db.prepare(`SELECT * FROM product_records WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit).map(record),total:db.prepare(`SELECT COUNT(*) n FROM product_records WHERE ${where}`).get(...args).n,page,limit};
}
export const fingerprint=data=>crypto.createHash('sha256').update(canonical(data)).digest('hex');
