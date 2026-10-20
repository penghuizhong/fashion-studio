// Guard the shared theme contract: UI colors are tokens; garment/color examples remain content.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postcss from 'postcss';
const src=fileURLToPath(new URL('../src/',import.meta.url));
const literal=/#(?:[\da-f]{3,8})\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(|\b(?:white|black|red|blue|green|gray|grey|yellow|orange|purple)\b/i;
const palette=postcss.parse(fs.readFileSync(path.join(src,'theme.css'),'utf8'));
const defined=new Set(),refs=[];
function inspect(file){
 const text=fs.readFileSync(file,'utf8');
 if(file.endsWith('.css'))postcss.parse(text).walkDecls(d=>{
  if(d.prop.startsWith('--'))defined.add(d.prop);
  if(!file.endsWith('theme.css'))assert.ok(!literal.test(d.value),`UI color outside theme.css: ${path.relative(src,file)}:${d.source.start.line} ${d.prop}`);
  for(const match of d.value.matchAll(/var\((--[\w-]+)(\s*,)?/g))if(!match[2])refs.push([match[1],path.relative(src,file)]);
 });
 else if(/\.[jt]sx?$/.test(file)){
  for(const match of text.matchAll(/(?:\b(?:color|background|backgroundColor|borderColor|fill|stroke|outlineColor)\s*(?:=|:)\s*["'])([^"']*)["']/g))assert.ok(!literal.test(match[1]),`UI color in component: ${path.relative(src,file)} ${match[0]}`);
  for(const match of text.matchAll(/var\((--[\w-]+)(\s*,)?/g))if(!match[2])refs.push([match[1],path.relative(src,file)]);
 }
}
function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);if(fs.statSync(p).isDirectory())walk(p);else inspect(p);}}
walk(src);
for(const [name,file] of refs)assert.ok(defined.has(name),`Undefined theme variable ${name} in ${file}`);
for(const rule of palette.nodes.filter(n=>n.type==='rule'))assert.ok([':root','[data-theme="black"]'].includes(rule.selector),'Palette values must be global theme definitions');
const themes=palette.nodes.filter(n=>n.type==='rule');
const expected=['--surface-page','--surface-panel','--surface-control','--surface-card','--surface-raised','--surface-canvas','--surface-selected','--border-selected','--focus-ring','--text','--text-secondary'];
for(const theme of themes)for(const name of expected)assert.ok(theme.nodes.some(d=>d.prop===name),`${theme.selector} is missing ${name}`);
console.log(`Theme contract: centralized UI colors and ${defined.size} defined variables passed`);
