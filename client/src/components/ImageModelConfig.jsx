export default function ImageModelConfig({value={},onChange}){
  const update=(key,v)=>onChange({...value,[key]:v});
  const custom=value.custom_size || {enabled:false,min:256,max:2048,step:8,max_pixels:4194304};
  return <fieldset className="image-model-config"><legend>图片协议与能力（按服务商文档配置）</legend>
    <label>调用协议<select aria-label="图片调用协议" value={value.protocol||'openai_images'} onChange={e=>onChange({...value,protocol:e.target.value,edit:e.target.value==='dashscope'?false:value.edit,qualities:e.target.value==='openai_images'?value.qualities:[]})}><option value="openai_images">OpenAI Images · generations / edits</option><option value="dashscope">DashScope · 文生图</option><option value="dashscope_multimodal">DashScope · 多模态图像生成/编辑</option></select></label>
    <label className="inline-check"><input type="checkbox" checked={value.text!==false} onChange={e=>update('text',e.target.checked)}/>支持无参考图生成</label>
    <label className="inline-check"><input type="checkbox" disabled={value.protocol==='dashscope'} checked={!!value.edit} onChange={e=>update('edit',e.target.checked)}/>声明支持参考图（非实测结果）</label>
    {value.edit&&<label>参考图总上限<input aria-label="参考图总上限" type="number" min="1" max="16" value={value.max_images||1} onChange={e=>update('max_images',Number(e.target.value))}/></label>}
    <div>优先用于：{[['text','无图生成'],['single','单图编辑'],['multi','多图参考']].map(([key,label])=><label key={key} className="inline-check"><input type="checkbox" checked={(value.default_for||[]).includes(key)} onChange={e=>update('default_for',e.target.checked?[...(value.default_for||[]),key]:(value.default_for||[]).filter(v=>v!==key))}/>{label}</label>)}</div>
    {(!value.protocol||value.protocol==='openai_images')&&<details><summary>接口路径与返回格式</summary><p className="dim small">留空使用标准 Images 接口；路径相对供应商地址，不填写其他域名。</p><label>无图生成路径<input value={value.generation_path||''} placeholder="默认 /images/generations" onChange={e=>update('generation_path',e.target.value)}/></label><label>图片编辑路径<input value={value.edit_path||''} placeholder="默认 /images/edits" onChange={e=>update('edit_path',e.target.value)}/></label><label>返回格式<select value={value.response_format||'b64_json'} onChange={e=>update('response_format',e.target.value)}><option value="b64_json">Base64</option><option value="url">图片URL</option><option value="omit">不传此参数（模型原生默认）</option></select></label><label className="inline-check"><input type="checkbox" checked={!!value.seed} onChange={e=>update('seed',e.target.checked)}/>支持发送 seed 参数</label></details>}
    <details><summary>尺寸与质量</summary>
      <label className="inline-check"><input type="checkbox" checked={!!custom.enabled} onChange={e=>update('custom_size',{...custom,enabled:e.target.checked})}/>支持自定义尺寸</label>
      {custom.enabled&&<div className="custom-size-row">{[['min','最小边'],['max','最大边'],['step','尺寸倍数'],['max_pixels','像素总上限']].map(([k,label])=><label key={k}>{label}<input type="number" value={custom[k]} onChange={e=>update('custom_size',{...custom,[k]:Number(e.target.value)})}/></label>)}</div>}
      {(!value.protocol||value.protocol==='openai_images')&&<label>质量档位（原生值:显示名称）<input aria-label="质量档位配置" value={(value.qualities||[]).map(q=>`${q.value}:${q.label}`).join(',')} placeholder="low:轻量,medium:标准,high:精细（以模型文档为准）" onChange={e=>update('qualities',e.target.value.split(/[,，]/).filter(Boolean).map(v=>{const [native,...label]=v.split(':');return {value:native.trim(),label:label.join(':').trim()||native.trim()};}))}/></label>}
      <p className="dim small">尺寸和质量只传原生参数；勾选仅声明能力，请保存后分项测试。当前不支持蒙版。</p>
    </details>
  </fieldset>;
}
