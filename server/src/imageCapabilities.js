import crypto from 'node:crypto';
import { imageOptions, sizeAllowed } from '../../shared/imageOptions.js';
import { problem } from './exploreErrors.js';
export { imageOptions };
export function modelSignature(model,provider) {
  return crypto.createHash('sha256').update(JSON.stringify([model.provider_id,model.model_id,model.kind,model.extra,provider?.preset,provider?.base_url,provider?.api_key_encrypted])).digest('hex');
}
export function chooseOutput(model,size,quality='') {
  const options=model.capabilities;
  if(!sizeAllowed(options,size))throw problem('INVALID_SIZE','该模型不支持此尺寸，请选择原生档位或有效自定义尺寸');
  if(quality && !options.qualities.some(q=>q.value===quality))throw problem('INVALID_QUALITY','该模型不支持此质量档位');
  const rates=model.pricing.image_rates;
  let unit=model.price_per_call;
  if(Array.isArray(rates) && rates.length){
    const matches=rates.filter(r=>(r.size==='*'||r.size===size)&&(r.quality==='*'||r.quality===quality));
    matches.sort((a,b)=>((b.size!=='*')+(b.quality!=='*'))-((a.size!=='*')+(a.quality!=='*')));
    if(matches.length>1 && ((matches[0].size!=='*')+(matches[0].quality!=='*'))===((matches[1].size!=='*')+(matches[1].quality!=='*')) && matches[0].per_call!==matches[1].per_call)throw problem('PRICE_NOT_CONFIGURED','分档价格规则冲突，请管理员核对',422);
    unit=matches[0]?.per_call;
  }
  if(!Number.isSafeInteger(unit)||unit<0||unit>1e9)throw problem('PRICE_NOT_CONFIGURED','此尺寸和质量尚未配置有效积分价格',422);
  return {size,quality,unit};
}
