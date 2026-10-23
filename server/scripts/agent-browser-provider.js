// Native tool protocol fixture used only by the isolated Playwright server.
export function agentBrowserResponse(body){
  const initial=JSON.parse(body.messages.find(m=>m.role==='user').content.find(c=>c.type==='text').text);
  const completed=body.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).filter(Boolean);
  const generated=completed.filter(r=>r.status==='succeeded'&&r.assetId),calls=body.messages.flatMap(m=>m.tool_calls||[]),names=calls.map(c=>c.function.name);
  let name,args;
  if(!names.includes('list_skills')){name='list_skills';args={};}
  else if(!names.includes('load_skill')){name='load_skill';args={name:'virtual-tryon'};}
  else if(initial.planningOnly&&!names.includes('propose_plan')){name='propose_plan';args={steps:[{id:'front',tool:'generate_image',title:'正面换装',dependsOn:[]},{id:'back',tool:'generate_image',title:'背面视角',dependsOn:['front']},{id:'side',tool:'generate_image',title:'侧面视角',dependsOn:['front']},{id:'layout',tool:'arrange_images',title:'横向排版',dependsOn:['front','back','side']}]};}
  else if(generated.length<initial.maxImages){name='generate_image';args={assetIds:initial.sources.map(s=>s.assetId),prompt:`图1服装穿到图2模特，视角${generated.length+1}`,title:`视角${generated.length+1}`};}
  else if(!names.includes('arrange_images')){name='arrange_images';args={assetIds:generated.map(s=>s.assetId)};}
  const message=name?{content:null,tool_calls:[{id:`call-${calls.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:'已按真实工具结果完成换装及排列。'};
  return new Response(JSON.stringify({choices:[{message,finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20}}),{headers:{'Content-Type':'application/json'}});
}
