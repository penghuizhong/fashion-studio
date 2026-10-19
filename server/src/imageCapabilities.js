import { imageRateMatch } from '../../shared/imagePricing.js';
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
    const matched=imageRateMatch(rates,size,quality);
    if(matched.error)throw problem('PRICE_NOT_CONFIGURED',matched.error,422);
    unit=matched.unit;
  }
  if(!Number.isSafeInteger(unit)||unit<0||unit>1e9)throw problem('PRICE_NOT_CONFIGURED','此尺寸和质量尚未配置有效积分价格',422);
  return {size,quality,unit};
}
