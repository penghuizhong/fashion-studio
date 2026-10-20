import {useEffect,useRef,useState} from 'react';
import {api} from '../api.js';
import {useAuth} from '../auth.jsx';
const editable=['code','notes','process','measurements','colors','sizes','materials','fees','currency','deadline','scope_notes','standard_exception','skus'];
const pick=d=>Object.fromEntries(editable.filter(k=>Object.hasOwn(d,k)).map(k=>[k,d[k]]));
const encoded=d=>JSON.stringify(pick(d));
export default function useProjectDraft(project,onSaved){
 const {user,multiUser}=useAuth(),key=`style-draft-product:project:${multiUser?user?.id||'guest':'local'}:${project.id}`;
 const cache=useRef(undefined);if(cache.current===undefined){try{const s=JSON.parse(sessionStorage.getItem(key));cache.current=s&&Date.now()-s.at<86400000?s:null;}catch{cache.current=null;}}
 const initial=cache.current?{...project.data,...cache.current.data}:project.data;
 const restoredConflict=!!cache.current&&cache.current.revision!==project.revision;
 const [data,setData]=useState(initial),[saving,setSaving]=useState(false),[error,setError]=useState(restoredConflict?'草稿期间服务器资料已更新，请选择采用方式':''),[conflict,setConflict]=useState(restoredConflict);
 const server=useRef(project),draft=useRef(initial),base=useRef(cache.current?.base||project.data),dirty=useRef(!!cache.current),flight=useRef(null),live=useRef(true),keys=useRef(new Map()),blocked=useRef(conflict);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const persist=()=>{try{if(dirty.current)sessionStorage.setItem(key,JSON.stringify({at:Date.now(),revision:server.current.revision,data:pick(draft.current),base:pick(base.current)}));else sessionStorage.removeItem(key);}catch{}};
 const set=next=>{if(!dirty.current)base.current=server.current.data;draft.current=typeof next==='function'?next(draft.current):next;dirty.current=true;setData(draft.current);if(!blocked.current)setError('');persist();};
 useEffect(()=>{if(project.revision<server.current.revision)return;server.current=project;if(!dirty.current){base.current=project.data;draft.current=project.data;setData(project.data);}},[project.revision]);
 const flush=()=>{
  if(flight.current)return flight.current;
  const drain=async()=>{
   if(blocked.current)throw new Error('资料有并发修改，请选择保留服务器资料或采用本地修改');
   while(dirty.current){const body={expected_revision:server.current.revision,data:pick(draft.current)},signature=JSON.stringify(body);if(!keys.current.has(signature))keys.current.set(signature,crypto.randomUUID());const captured=encoded(draft.current);if(live.current)setSaving(true);
    try{
     const r=await api.products.post(`projects/${project.id}/save`,{...body,request_key:keys.current.get(signature)});keys.current.delete(signature);server.current=r.project;
     if(encoded(draft.current)===captured){dirty.current=false;draft.current=r.project.data;base.current=r.project.data;if(live.current)setData(r.project.data);}
     if(live.current){onSaved(r.project);setError('');}persist();
    }catch(e){if(e.code==='PRODUCT_CONFLICT'){blocked.current=true;if(live.current)setConflict(true);}if(live.current)setError(e.message);throw e;}
    finally{if(live.current)setSaving(false);}
   }return server.current;
  };
  const promise=drain();flight.current=promise;promise.finally(()=>{if(flight.current===promise)flight.current=null;}).catch(()=>{});return promise;
 };
 useEffect(()=>{if(!dirty.current||blocked.current)return;const timer=setTimeout(()=>flush().catch(()=>{}),700);return()=>clearTimeout(timer);},[data]);
 const resolve=async useLocal=>{
  if(flight.current)await flight.current.catch(()=>{});
  const r=await api.products.get(`projects/${project.id}`),latest=r.project;
  const changed=Object.fromEntries(Object.entries(pick(draft.current)).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(base.current[k])));
  server.current=latest;base.current=latest.data;blocked.current=false;setConflict(false);setError('');
  draft.current=useLocal?{...latest.data,...changed}:latest.data;dirty.current=useLocal;setData(draft.current);onSaved(latest);persist();if(useLocal)return flush();return latest;
 };
 return {data,set,flush,saving,error,conflict,resolve,dirty:dirty.current,current:server};
}
