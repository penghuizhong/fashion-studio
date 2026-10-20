import { imageTaskAllowed, sizeAllowed } from '../../../shared/imageOptions.js';
import { normalizeCamera, validateCameraIntent } from '../../../shared/photography.js';

// Editing is a pending state. Only complete requests reach the quote API.
export function generationIssue({data,version,form,model,dirty,active,retryJob,target}) {
  const issue = (section,message) => ({section,message});
  if (!data || !version) return issue('quote','正在加载款式资料');
  if (data.template.lifecycle !== 'active') return issue('quote','恢复款式后即可生成');
  if (dirty) return issue('attributes','请在款式属性中保存或取消修改');
  if (active) return issue('quote','请等待当前任务完成');
  if (retryJob) return null; // Retry uses the persisted job settings.
  if (!['create','free_design'].includes(form.op) && (form.mode !== 'image' || !form.source)) return issue('references','请选择参考图');
  if (form.mode === 'image' && !form.source) return issue('references','请选择参考图');
  if (!model) return issue('output','请选择图片模型');
  const count = form.mode === 'image' ? 1 + form.references.length : 0;
  if (!imageTaskAllowed(model.capabilities,count)) return issue('output',count?'请选择支持所选参考图的模型':'请选择支持文字生图的模型');
  if (model.price_per_call === null) return issue('output','所选模型尚未配置价格，请更换模型');
  if (!sizeAllowed(model.capabilities,form.size)) return issue('output','请调整图片尺寸以符合模型限制');
  if (form.quality && !model.capabilities.qualities?.some(q=>q.value===form.quality)) return issue('output','请选择当前模型支持的生成质量');
  if (!Number.isInteger(form.count) || form.count < 1 || form.count > 16) return issue('output','生成张数需为 1–16 的整数');
  if (form.op === 'free_design' && !form.instruction.trim()) return issue('instruction','请描述本次设计变化');
  if (['recolor','detail_modify'].includes(form.op)) {
    let delta=[];try {delta=JSON.parse(version.summary);} catch {}
    if (target.trim() || !version.parent_id || !Array.isArray(delta) || !delta.some(d=>form.op==='recolor'?/color/.test(d.key):d.key==='details')) return issue('instruction','请先保存颜色或细节变化');
  }
  if (form.op === 'scene' && !form.instruction.trim()) return issue('instruction','请描述想要的场景');
  try {
    const camera=normalizeCamera(form.camera);
    validateCameraIntent(camera,form.instruction);
    if (form.op==='detail_shot' && camera.framing!=='detail') return issue('camera','请选择局部特写及具体部位');
    if (form.op==='recolor' && camera.framing==='detail') return issue('camera','换色请使用完整单品或全身取景');
  } catch(e) { return issue('camera',e.message); }
  if (form.op==='white' && /海滩|海岛|街道|森林|沙滩|非白|黑色背景|beach|forest|street|black background/i.test(form.instruction)) return issue('instruction','背景要求与白底商品图冲突，请修改要求或选择换场景');
  return null;
}
export function generationErrorSection(code='') {
  if (/SOURCE|REFERENCE/.test(code)) return 'references';
  if (/MODEL|EDIT|PRICE|PRICING|SIZE|QUALITY|OUTPUT|COUNT/.test(code) && !/QUOTE/.test(code)) return 'output';
  if (/CAMERA/.test(code)) return 'camera';
  if (/INSTRUCTION|DESIGN_VERSION|BACKGROUND/.test(code)) return 'instruction';
  return 'quote';
}
