import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
export const mergeRecords = (before=[], after=[]) => { const map=new Map(before.map(i=>[i.id,i]));for(const i of after)map.set(i.id,{...map.get(i.id),...i});return [...map.values()]; };
export default function useWorkspaceCollections(templateId,setData,context) {
  const live=useRef(true),controllers=useRef(new Map()),contexts=useRef(context);
  contexts.current=context;
  const [pages,setPages]=useState({});
  const [ids,setIds]=useState({});
  useEffect(()=>{live.current=true;return()=>{live.current=false;controllers.current.forEach(c=>c.abort());};},[]);
  const fetchPage=useCallback(async(collection,page=1,extra={})=>{
    const ctx=contexts.current;
    const params={page,limit:20,...(collection==='images'?{version_id:ctx.versionId,state:ctx.imageState}:collection==='layoutImages'?{state:'active'}:{}),...extra};
    const target=collection==='layoutImages'?'images':collection;
    controllers.current.get(collection)?.abort();
    const controller=new AbortController();controllers.current.set(collection,controller);
    setPages(p=>({...p,[collection]:{...p[collection],loading:true,error:''}}));
    try{
      const r=await api.studio.workspaceItems(templateId,target,params,{signal:controller.signal});
      if(!live.current||controller.signal.aborted)return;
      setData(d=>d?{...d,[target]:mergeRecords(d[target],r.items)}:d);
      setIds(old=>({...old,[collection]:page===1?r.items.map(i=>i.id):[...new Set([...(old[collection]||[]),...r.items.map(i=>i.id)])]}));
      setPages(p=>({...p,[collection]:{page:r.page,total:r.total,limit:r.limit,loading:false,error:''}}));
      return r;
    }catch(e){if(live.current&&!controller.signal.aborted)setPages(p=>({...p,[collection]:{...p[collection],loading:false,error:e.message}}));}
  },[templateId,setData]);
  return {pages,ids,fetchPage};
}
export function CollectionMore({name,info,onLoad}) {
  if(!info)return null;
  return <div className="collection-more">
    {info.error&&<p role="alert">{info.error} <button className="btn secondary small" onClick={()=>onLoad(info.page||1)}>重试</button></p>}
    {info.loading?<span role="status">正在加载{name}…</span>:<>
      <small>共 {info.total||0} 条</small>
      {info.page*info.limit<info.total&&<button className="btn secondary small" onClick={()=>onLoad(info.page+1)}>加载更多{name}</button>}
    </>}
  </div>;
}
