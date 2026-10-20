import { useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { previewIsReady, rememberPreview } from './studioPreviewCache.js';
function Preview({ original, thumbnail, alt, actual, available, scope }) {
  const url = original ? `/api/studio/preview?${new URLSearchParams({path:original,viewer:scope})}` : '';
  const [ready,setReady]=useState(()=>previewIsReady(url));
  const [failed,setFailed]=useState(false),[thumbFailed,setThumbFailed]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!url||actual||available===false)return;
    let live=true, timer;
    const img=new Image();img.decoding='async';
    img.onload=async()=>{try{await img.decode();if(live){rememberPreview(url);setReady(true);setFailed(false);}}catch{if(live)setFailed(true);}};
    img.onerror=()=>{if(!live)return;setFailed(true);if(attempt<4)timer=setTimeout(()=>setAttempt(n=>n+1),800*(attempt+1));};
    img.src=url;
    return()=>{live=false;clearTimeout(timer);img.onload=null;img.onerror=null;img.removeAttribute('src');};
  },[url,actual,available,attempt]);
  if(!original&&!thumbnail)return <p role="status">尚无图片</p>;
  const thumb=thumbnail&&!thumbFailed?`/${thumbnail}`:null;
  const src=actual&&available!==false?`/${original}`:ready&&available!==false?url:thumb;
  return <div className={`progressive-studio-image${actual?' actual':''}`} data-preview-ready={ready?'true':'false'}>
    {src&&<img src={src} alt={alt||''} decoding="async" onError={()=>{if(src===thumb)setThumbFailed(true);else{setReady(false);setFailed(true);}}}/>}
    {!actual&&(!ready||available===false)&&<span role="status" className="preview-status">{available===false?'原图缺失 · 仅显示可用缩略图':failed?'清晰预览暂不可用 · 暂用缩略图':thumb?'缩略图预览 · 正在加载清晰预览':'正在加载图片预览…'}</span>}
    {!actual&&failed&&available!==false&&<button className="btn secondary small preview-retry" onClick={()=>{setFailed(false);setAttempt(n=>n+1);}}>重试加载预览</button>}
    {!src&&available===false&&<span role="status">图片文件缺失</span>}
    {actual&&failed&&<span role="alert">原图加载失败</span>}
  </div>;
}
export default function ProgressiveStudioImage(props){
  const {user,multiUser}=useAuth();const scope=String(multiUser?user?.id||user?.username||'anonymous':'local');
  return <Preview key={`${scope}:${props.original}:${props.actual}`} {...props} scope={scope}/>;
}
