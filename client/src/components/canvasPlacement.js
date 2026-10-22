export function resultPlacement(editor, sourceIds, width, height) {
  const source=sourceIds.map(id=>id&&editor.getShapePageBounds(id)).find(Boolean);
  const viewport=editor.getViewportPageBounds();
  let x=source?source.maxX+96:viewport.center.x-width/2;
  const y=source?.y??viewport.center.y-height/2;
  const boxes=editor.getCurrentPageShapes().map(s=>editor.getShapePageBounds(s)).filter(Boolean);
  // Move right of every overlapping object; never replace an existing input image.
  for(let i=0;i<=boxes.length;i++){
    const collision=boxes.find(b=>x<b.maxX+24&&x+width>b.x-24&&y<b.maxY+24&&y+height>b.y-24);
    if(!collision)break;
    x=collision.maxX+96;
  }
  return {x,y};
}
export function fitCanvas(editor) {
  const boxes=editor.getCurrentPageShapes().filter(s=>!s.meta.hidden).map(s=>editor.getShapePageBounds(s)).filter(Boolean);
  if(!boxes.length)return;
  const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y)),w=Math.max(...boxes.map(b=>b.maxX))-x,h=Math.max(...boxes.map(b=>b.maxY))-y;
  const viewport=editor.getViewportScreenBounds(),layers=editor.getContainer().querySelector('.canvas-layers');
  const left=layers?layers.getBoundingClientRect().width+24:24,bottom=110;
  const z=Math.max(.01,Math.min(1,(viewport.w-left-24)/Math.max(1,w),(viewport.h-bottom-24)/Math.max(1,h)));
  editor.setCamera({x:(left+(viewport.w-left-24-w*z)/2)/z-x,y:(24+(viewport.h-bottom-24-h*z)/2)/z-y,z},{animation:{duration:150}});
}
