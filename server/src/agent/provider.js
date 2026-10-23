import { createAssistantMessageEventStream, getSystemMessageText } from '@earendil-works/pi-ai';
import { llmFetch } from '../llm.js';

// Native OpenAI-compatible tool protocol, deliberately no SDK/network retries.
// Existing registry remains the only credential/model source.
export function wireContext(context) {
  const tools=context.messages.filter(m=>m.role==='system').flatMap(m=>m.toolsAdded||[]);
  const messages=context.messages.map(m=>{
    if(m.role==='system')return {role:'system',content:getSystemMessageText(m)};
    if(m.role==='toolResult')return {role:'tool',tool_call_id:m.toolCallId,content:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')};
    if(m.role==='assistant'){
      const calls=m.content.filter(c=>c.type==='toolCall');
      return {role:'assistant',content:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')||null,...(calls.length?{tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}:{})};
    }
    return {role:'user',content:m.content.map(c=>c.type==='image'?{type:'image_url',image_url:{url:`data:${c.mimeType};base64,${c.data}`,detail:'low'}}:{type:'text',text:c.text||''})};
  });
  // OpenAI tool messages accept text only: make actual tool-result images visible in a user message.
  const expanded=[];
  for(let i=0;i<context.messages.length;i++){
    expanded.push(messages[i]);
    if(context.messages[i].role==='toolResult'){
      const images=context.messages[i].content.filter(c=>c.type==='image');
      // Must follow all tool results in a batch, not interleave user messages among them.
      if(images.length)expanded[expanded.length-1]._images=images;
    }
  }
  const final=[],pending=[];
  for(const m of expanded){
    const {_images,...clean}=m;
    if(m.role!=='tool'&&pending.length){final.push({role:'user',content:pending.splice(0).map(c=>({type:'image_url',image_url:{url:`data:${c.mimeType};base64,${c.data}`,detail:'low'}}))});}
    final.push(clean);if(_images)pending.push(..._images);
  }
  if(pending.length)final.push({role:'user',content:pending.map(c=>({type:'image_url',image_url:{url:`data:${c.mimeType};base64,${c.data}`,detail:'low'}}))});
  return {messages:final,tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}))};
}
async function readResponse(response,message,stream){
  const streaming=response.headers.get('content-type')?.includes('text/event-stream');
  let size=0,frames=0,buffer='',usage=null,finish=null,content='',textIndex=-1;const calls=new Map(),decoder=new TextDecoder();
  const consume=frame=>{
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')return;
    if(++frames>512)throw Error('AGENT_STREAM_EVENT_LIMIT');
    const json=JSON.parse(data);if(json.error)throw Error('AGENT_STREAM_ERROR');if(json.usage)usage=json.usage;
    const choice=json.choices?.[0];if(!choice)return;if(choice.finish_reason)finish=choice.finish_reason;
    const delta=choice.delta||{};
    if(typeof delta.content==='string'&&delta.content){
      if(textIndex<0){textIndex=message.content.length;message.content.push({type:'text',text:''});stream.push({type:'text_start',contentIndex:textIndex,partial:structuredClone(message)});}
      content+=delta.content;if(content.length>16000)throw Error('AGENT_RESPONSE_LIMIT');message.content[textIndex].text=content;stream.push({type:'text_delta',contentIndex:textIndex,delta:delta.content,partial:structuredClone(message)});
    }
    for(const c of delta.tool_calls||[]){
      if(!Number.isInteger(c.index)||c.index<0||c.index>3)throw Error('AGENT_TOOL_BATCH_LIMIT');
      let call=calls.get(c.index);
      if(!call){call={id:'',type:'function',function:{name:'',arguments:''},contentIndex:message.content.length};calls.set(c.index,call);message.content.push({type:'toolCall',id:'',name:'',arguments:{}});stream.push({type:'toolcall_start',contentIndex:call.contentIndex,partial:structuredClone(message)});}
      if(c.id)call.id=c.id;if(c.function?.name)call.function.name+=c.function.name;
      if(c.function?.arguments)call.function.arguments+=c.function.arguments;
      if(call.function.arguments.length>16000||call.function.name.length>100||call.id.length>100)throw Error('AGENT_RESPONSE_LIMIT');
      const partial=message.content[call.contentIndex];partial.id=call.id;partial.name=call.function.name;
      try{partial.arguments=JSON.parse(call.function.arguments);}catch{partial.arguments={};}
      stream.push({type:'toolcall_delta',contentIndex:call.contentIndex,delta:c.function?.arguments||'',partial:structuredClone(message)});
    }
  };
  for await(const chunk of response.body){
    size+=chunk.length;if(size>2*1024*1024)throw Error('AGENT_RESPONSE_LIMIT');buffer+=decoder.decode(chunk,{stream:true}).replace(/\r/g,'');
    if(streaming){let end;while((end=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,end));buffer=buffer.slice(end+2);}}
  }
  buffer+=decoder.decode();
  if(!streaming)return JSON.parse(buffer);
  if(buffer.trim())consume(buffer);
  if(!finish)throw Error('AGENT_STREAM_INTERRUPTED');
  return {usage,choices:[{finish_reason:finish,message:{content,tool_calls:[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([,c])=>({id:c.id,type:c.type,function:c.function}))}}]};
}
export function nativeStream({resolved,beforeRequest,onResult,onFailure,fetchFn=llmFetch}) {
  return (model,context,options={})=>{
    const stream=createAssistantMessageEventStream();
    const message={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
    (async()=>{
      let dispatched=false;
      try{
        const body={model:resolved.model_id,...wireContext(context),stream:true,stream_options:{include_usage:true},max_tokens:1600,temperature:0.2,parallel_tool_calls:false};
        // UTF8 text bytes are a conservative token bound; low-detail image allowance is separate.
        const textBytes=Buffer.byteLength(JSON.stringify(body,(k,v)=>k==='url'&&typeof v==='string'&&v.startsWith('data:')?'[image]':v));
        const imageCount=JSON.stringify(body).match(/data:image\//g)?.length||0;
        if(textBytes+imageCount*4096>100000)throw Error('AGENT_CONTEXT_LIMIT');
        await beforeRequest(body);dispatched=true;
        const response=await fetchFn(`${resolved.baseUrl.replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${resolved.apiKey}`},body:JSON.stringify(body),signal:AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(120000)])});
        if(!response.ok){const error=Error('AGENT_PROVIDER_REJECTED');error.definite=response.status>=400&&response.status<500&&response.status!==408;await response.body?.cancel();throw error;}
        stream.push({type:'start',partial:structuredClone(message)});
        const json=await readResponse(response,message,stream);
        message.content=[];
        const raw=json.choices?.[0]?.message;
        const input=json.usage?.prompt_tokens,output=json.usage?.completion_tokens;
        const valid=[input,output].every(v=>Number.isSafeInteger(v)&&v>=0);
        message.usage={...message.usage,input:valid?input:100000,output:valid?output:1600,totalTokens:valid?input+output:101600};
        // Charge a completed provider response even if its tool protocol is malformed.
        await onResult(message.usage,valid);dispatched=false;
        if(!raw||raw.refusal||!['stop','tool_calls'].includes(json.choices[0].finish_reason||'stop'))throw Error('AGENT_PROVIDER_PROTOCOL');
        if(typeof raw.content==='string'&&raw.content)message.content.push({type:'text',text:raw.content});
        if((raw.tool_calls?.length||0)>4)throw Error('AGENT_TOOL_BATCH_LIMIT');
        for(const c of raw.tool_calls||[]){
          if(c.type!=='function'||typeof c.id!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(c.id)||!c.function?.name)throw Error('AGENT_PROVIDER_PROTOCOL');
          message.content.push({type:'toolCall',id:c.id,name:c.function.name,arguments:JSON.parse(c.function.arguments)});
        }
        if(!message.content.length)throw Error('AGENT_EMPTY_RESPONSE');
        message.stopReason=message.content.some(c=>c.type==='toolCall')?'toolUse':'stop';
        for(const [contentIndex,c] of message.content.entries())stream.push(c.type==='toolCall'?{type:'toolcall_end',contentIndex,toolCall:c,partial:message}:{type:'text_end',contentIndex,content:c.text,partial:message});
        stream.push({type:'done',reason:message.stopReason,message});
      }catch(error){
        await onFailure(error,dispatched);
        message.stopReason=options.signal?.aborted?'aborted':'error';message.errorMessage=error.message?.startsWith('AGENT_')?error.message:'AGENT_REQUEST_UNCERTAIN';
        stream.push({type:'error',reason:message.stopReason,error:message});
      }
    })().catch(()=>{message.stopReason='error';message.errorMessage='AGENT_PERSISTENCE_FAILED';stream.push({type:'error',reason:'error',error:message});});
    return stream;
  };
}
