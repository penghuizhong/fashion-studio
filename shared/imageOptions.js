// Serializable capability contract shared by settings, both studios and quoting.
export const IMAGE_PROTOCOLS = ['openai_images', 'dashscope', 'dashscope_multimodal'];
export const QUALITY_LABELS = {auto:'自动',low:'轻量',medium:'标准',high:'精细',standard:'标准',hd:'精细'};
export const RATIOS = ['1:1','3:4','2:3','4:3','3:2','4:5','5:4','9:16','16:9','21:9'];
export function imageOptions(extra = {}, preset = 'custom') {
  const c = extra.image_config || {};
  const protocol = c.protocol || (preset === 'dashscope' ? 'dashscope' : preset === 'custom' ? 'openai_images' : null);
  const editable = protocol === 'openai_images' || protocol === 'dashscope_multimodal';
  const edit = editable && (c.edit ?? extra.image_edit) === true;
  const maxImages = edit ? Math.max(1,Math.min(16,Number(c.max_images) || (extra.multi_reference ? 4 : 1))) : 0;
  return {
    default_for:Array.isArray(c.default_for)?c.default_for.filter(x=>['text','single','multi'].includes(x)):[],
    generation_path:c.generation_path||'',edit_path:c.edit_path||'',response_format:c.response_format||'b64_json',seed:protocol==='openai_images'&&(c.seed??!extra.image_config),
    protocol, text: IMAGE_PROTOCOLS.includes(protocol) && c.text !== false,
    image_edit:edit,multi_reference:maxImages>1,max_images:maxImages,mask:false,
    sizes: Array.isArray(extra.sizes) && extra.sizes.length ? extra.sizes.filter(x=>typeof x==='string') : ['1024x1024'],
    qualities: protocol === 'openai_images' && Array.isArray(c.qualities) ? c.qualities.filter(q=>q && /^[\w-]{1,32}$/.test(q.value) && typeof q.label==='string').map(q=>({value:q.value,label:q.label.slice(0,30)})) : [],
    custom_size:c.custom_size?.enabled === true ? {enabled:true,min:Math.max(64,Number(c.custom_size.min)||256),max:Math.min(8192,Number(c.custom_size.max)||2048),step:Math.max(1,Number(c.custom_size.step)||8),max_pixels:Math.min(16777216,Number(c.custom_size.max_pixels)||4194304)} : null,
  };
}
export function sizeNumbers(size) { const m=/^(\d{2,5})[x*](\d{2,5})$/.exec(size||'');return m?[Number(m[1]),Number(m[2])]:null; }
export function sizeAllowed(options,size) {
  if(options.sizes.includes(size))return true;
  const n=sizeNumbers(size), c=options.custom_size;
  return !!(n && c && n.every(v=>Number.isInteger(v)&&v>=c.min&&v<=c.max&&v%c.step===0) && n[0]*n[1]<=c.max_pixels);
}
export function ratioLabel(size) {const n=sizeNumbers(size); if(!n)return size;const common=RATIOS.find(r=>{const [w,h]=r.split(':').map(Number);return n[0]*h===n[1]*w;});if(common)return common;const gcd=(a,b)=>b?gcd(b,a%b):a;const d=gcd(...n);return `${n[0]/d}:${n[1]/d}`;}

export function imageTaskAllowed(cap,count=0){
 const task=count>1?'multi':count===1?'single':'text';
 return cap?.task_status?.[task]!=='failed' && (count===0?!!cap?.text:!!cap?.image_edit && count<=cap.max_images);
}
