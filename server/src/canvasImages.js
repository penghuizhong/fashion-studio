import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { localImage } from './styleWorkspace.js';
import { problem } from './exploreErrors.js';
export function canvasCrop(value) {
  if(value==null)return null;
  const a=value.topLeft,b=value.bottomRight;
  if(!a||!b||![a.x,a.y,b.x,b.y].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1)||b.x<=a.x||b.y<=a.y)throw problem('CANVAS_CROP_INVALID','图片裁剪范围无效');
  return {topLeft:{x:a.x,y:a.y},bottomRight:{x:b.x,y:b.y}};
}
export async function canvasSourceBytes(source) {
  const bytes=fs.readFileSync(localImage(source.path));
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==source.assetVersion)throw problem('CANVAS_SOURCE_CHANGED','参考图片已变化，请重新添加',409);
  if(!source.crop&&!source.flipX&&!source.flipY)return bytes;
  let image=sharp(bytes,{limitInputPixels:40000000}).rotate();
  const oriented=await image.png().toBuffer(),meta=await sharp(oriented).metadata();
  image=sharp(oriented);
  if(source.crop){const {topLeft:a,bottomRight:b}=source.crop,left=Math.floor(a.x*meta.width),top=Math.floor(a.y*meta.height),right=Math.min(meta.width,Math.ceil(b.x*meta.width)),bottom=Math.min(meta.height,Math.ceil(b.y*meta.height));image=image.extract({left,top,width:Math.max(1,right-left),height:Math.max(1,bottom-top)});}
  if(source.flipX)image=image.flop();
  if(source.flipY)image=image.flip();
  return image.png().toBuffer();
}
