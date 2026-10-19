import { getDb } from './db.js';
import { getModel,getProviderCreds } from './registry.js';
import { modelSignature,imageOptions } from './imageCapabilities.js';
import { generateImage,saveStudioImage } from './image.js';
import { getConfig } from './config.js';
import { problem } from './exploreErrors.js';
import { llmFetch } from './llm.js';
import sharp from 'sharp';
import crypto from 'node:crypto';
export async function testRegisteredModel(req) {
  const db=getDb(), body=req.body || {};
  const id=body.id||body.model_id;
  if(typeof id!=='string'||!id.trim())throw problem('INVALID_MODEL','请选择具体供应商下的模型记录');
  const model=getModel(id);
  if(!model)throw problem('MODEL_NOT_FOUND','请选择具体供应商下的模型记录',404);
  const provider=db.prepare('SELECT * FROM providers WHERE id=?').get(model.provider_id),creds=getProviderCreds(model.provider_id);
  if(!provider?.is_active || !model.is_active)throw problem('MODEL_UNAVAILABLE','供应商或模型已停用',422);
  if(!getConfig().mockLlm && (!creds?.apiKey || !creds?.baseUrl))throw problem('MODEL_NOT_CONFIGURED','供应商地址或密钥未配置',422);
  const task=body.task || (model.kind==='chat'?'chat':'text');
  if(!['chat','text','single','multi'].includes(task) || (model.kind==='chat')!==(task==='chat'))throw problem('INVALID_TEST','测试类型与模型不匹配');
  if(body.confirm!==true)throw problem('CONFIRM_REQUIRED','测试可能产生上游费用，请确认后执行');
  const signature=modelSignature(model,provider), started=Date.now();
  let status=getConfig().mockLlm?'simulated':'passed', message='',preview=null;
  try {
    if(task==='chat') {
      if(!getConfig().mockLlm){
        const r=await llmFetch(creds.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${creds.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:model.model_id,messages:[{role:'user',content:'Reply OK'}],max_tokens:16}),signal:AbortSignal.timeout(30000)});
        if(!r.ok)throw Object.assign(new Error('模型请求失败'),{status:r.status});
        const j=await r.json();if(!j.choices?.[0]?.message)throw new Error('返回格式不符合当前聊天协议');
      }
    }else{
      const cap=imageOptions(model.extra,provider.preset);
      if(!cap.protocol || (task==='text'&&!cap.text) || (task!=='text'&&!cap.image_edit) || (task==='multi'&&cap.max_images<2))throw new Error('所选协议或声明能力不支持此测试，请先配置');
      const fixture=await sharp({create:{width:512,height:512,channels:3,background:'#234567'}}).png().toBuffer();
      const fixture2=await sharp({create:{width:512,height:512,channels:3,background:'#9a3412'}}).png().toBuffer();
      const r=await generateImage({modelId:model.id,prompt:task==='text'?'A simple blue shirt on white background.':'Use image 1 shape. Change its color to orange; if image 2 is provided use its color.',size:cap.sizes[0],sourceImageBase64:task==='text'?null:fixture.toString('base64'),referenceImages:task==='multi'?[fixture2.toString('base64')]:[],executionModel:{...model,...creds,model_id:model.model_id,capabilities:cap,price_per_call:0},deferBilling:true});
      preview=(await saveStudioImage(r.imageBase64,`admin-test-${crypto.randomUUID()}`)).image_path;
    }
    message=status==='simulated'?'仅模拟通过，未验证供应商真实能力':'接口调用成功，请检查参考图遵从效果';
  }catch(e){status='failed'; message=e.status?`上游 HTTP ${e.status}，请核对权限、协议及模型配置`:(['MODEL_NOT_CONFIGURED'].includes(e.code)?'供应商未配置': e.message==='所选协议或声明能力不支持此测试，请先配置'?e.message:'测试失败，请核对接口格式、返回格式或超时');}
  // A concurrent edit invalidates this result rather than blessing the changed config.
  db.prepare('INSERT INTO model_capability_checks(model_id,task,signature,status,message,preview_path,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(model_id,task) DO UPDATE SET signature=excluded.signature,status=excluded.status,message=excluded.message,preview_path=excluded.preview_path,created_at=excluded.created_at').run(model.id,task,signature,status,message,preview,new Date().toISOString());
  return {ok:status!=='failed',status,message,latency:Date.now()-started,preview:preview?`/api/admin/models/${model.id}/test-preview?task=${task}`:null};
}
