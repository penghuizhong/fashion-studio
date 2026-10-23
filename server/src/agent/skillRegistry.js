import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root=fileURLToPath(new URL('./skills/',import.meta.url));
export function discoverSkills(directory=root) {
  const base=fs.realpathSync(directory), seen=new Set();
  return fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)).map(entry=>{
    const file=path.join(base,entry.name,'SKILL.md'),resolved=fs.realpathSync(file);
    if(!resolved.startsWith(base+path.sep))throw Error('Skill path escapes root');
    if(fs.statSync(resolved).size>32768)throw Error('Skill exceeds 32KB');
    const source=fs.readFileSync(resolved,'utf8'),match=source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if(!match)throw Error('Skill YAML frontmatter required');
    const yaml=parseDocument(match[1],{uniqueKeys:true});
    if(yaml.errors.length)throw Error('Invalid Skill YAML');
    const meta=yaml.toJS({maxAliasCount:0});
    if(typeof meta?.name!=='string'||meta.name!==entry.name||meta.name.length>64||!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name)||seen.has(meta.name))throw Error('Invalid or duplicate Skill name');
    if(typeof meta.description!=='string'||!meta.description.trim()||meta.description.length>1024)throw Error('Invalid Skill description');
    if(meta.compatibility!==undefined&&(typeof meta.compatibility!=='string'||meta.compatibility.length>500))throw Error('Invalid Skill compatibility');
    if(meta.license!==undefined&&typeof meta.license!=='string')throw Error('Invalid Skill license');
    if(meta.metadata!==undefined&&(!meta.metadata||Array.isArray(meta.metadata)||typeof meta.metadata!=='object'||Object.values(meta.metadata).some(v=>typeof v!=='string')))throw Error('Invalid Skill metadata');
    seen.add(meta.name);
    return Object.freeze({name:meta.name,description:meta.description,license:meta.license||null,source:'builtin',enabled:!String(process.env.AGENT_DISABLED_SKILLS||'').split(',').map(s=>s.trim()).includes(meta.name),hash:crypto.createHash('sha256').update(source).digest('hex'),body:match[2]});
  });
}
export function skillMetadata(skills){return skills.map(({body,...meta})=>meta);}
