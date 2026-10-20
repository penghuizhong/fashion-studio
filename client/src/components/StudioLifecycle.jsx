import { useEffect,useRef,useState } from 'react';
import { api } from '../api.js';
export function StateTabs({value,onChange}){return <div className="studio-state-tabs" role="group" aria-label="内容状态">{[['active','使用中'],['archived','已归档'],['trash','回收站']].map(([v,label])=><button key={v} className={value===v?'selected':''} aria-pressed={value===v} onClick={()=>onChange(v)}>{label}</button>)}</div>;}
export function CardMenu({name,items}){
 const [open,setOpen]=useState(false),root=useRef(null),trigger=useRef(null);
 useEffect(()=>{if(!open)return;const outside=e=>{if(!root.current?.contains(e.target))setOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
 return <div className="studio-card-menu" ref={root} onClick={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}if(open&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const buttons=[...root.current.querySelectorAll('[role="menuitem"]')];const index=buttons.indexOf(document.activeElement);buttons[(index+(e.key==='ArrowDown'?1:buttons.length-1)+buttons.length)%buttons.length]?.focus();}}}>
  <button ref={trigger} type="button" aria-label={`${name}操作菜单`} aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(o=>!o)}>•••</button>
  {open&&<div role="menu" aria-label={`${name}操作`}>{items.map(({label,action,disabled})=><button role="menuitem" key={label} disabled={disabled} onClick={()=>{setOpen(false);trigger.current?.focus();action();}}>{label}</button>)}</div>}
 </div>;
}
export function useLifecycleActions({onChanged,showToast}){
 const [pending,setPending]=useState(null),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),dialog=useRef(null);
 useEffect(()=>{if(pending&&!dialog.current?.open)dialog.current?.showModal();},[pending]);
 const perform=async(kind,row,action)=>{
  try{
   if(action==='delete'){const r=await api.studio.lifecycleImpact(kind,row.id);setConfirm('');setPending({kind,row,impact:r.impact});return;}
   await api.studio.lifecycle(kind,row.id,action);showToast(action==='trash'?'已移入回收站':action==='archive'?'已归档':'已恢复');await onChanged();
  }catch(e){showToast(e.message||'操作失败');}
 };
 const close=()=>{if(!busy)setPending(null);};
 const modal=pending?<dialog ref={dialog} className="lifecycle-dialog" aria-label="永久移除确认" onCancel={e=>{e.preventDefault();close();}}>
  <h3>{pending.done?'记录已永久移除':'永久移除确认'}</h3>
  <p>{pending.row.name||pending.row.template_name||`记录 #${pending.row.id}`}</p>
  <p>涉及 {pending.impact.versions} 个设计版本、{pending.impact.images} 张图片。必要历史和计费审计保留。</p>
  <p>这里只移除记录，共享图片文件继续保留；回收站不会自动清空。</p>
  {pending.impact.busy&&<p role="alert">存在生成中或待核对任务，暂不能永久移除。</p>}
  {!pending.done&&<label>输入“永久删除”确认<input aria-label="永久删除确认" value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>}
  <div className="lifecycle-dialog-actions"><button className="btn secondary" disabled={busy} onClick={close}>关闭</button>
  {!pending.done&&<button className="btn danger" disabled={busy||confirm!=='永久删除'||pending.impact.busy} onClick={async()=>{setBusy(true);try{await api.studio.lifecycle(pending.kind,pending.row.id,'delete',confirm);setPending(p=>({...p,done:true}));await onChanged();showToast('记录已永久移除，共享文件保留');}catch(e){showToast(e.message);}finally{setBusy(false);}}}>永久移除此记录</button>}
  {pending.done&&pending.kind==='generations'&&<button className="btn secondary" disabled={busy} onClick={async()=>{setBusy(true);try{const r=await api.studio.cleanupFiles(pending.row.id);showToast(r.message);}catch(e){showToast(e.message);}finally{setBusy(false);}}}>清理未引用文件</button>}</div>
 </dialog>:null;
 return {perform,modal};
}
