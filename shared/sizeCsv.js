// Small quoted-CSV reader; data is subsequently checked by the same server validators as manual input.
export function parseSizeCsv(text) {
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(c===','&&!quoted){row.push(cell.trim());cell='';}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell='';}
  else cell+=c;
 }
 if(quoted)throw new Error('CSV引号未闭合');row.push(cell.trim());if(row.some(Boolean))rows.push(row);
 const header=rows.shift()?.map(s=>s.replace(/^\uFEFF/,''))||[];
 const required=['部位代码','部位名称','测量方法','口径','单位'];if(required.some(k=>!header.includes(k))||new Set(header).size!==header.length)throw new Error('CSV需包含部位代码、部位名称、测量方法、口径、单位，且列名不重复');
 const fixed=[...required,'数值','公差','单档增量'];const sizes=header.filter(k=>!fixed.includes(k));
 if(rows.length>100||sizes.length>30)throw new Error('最多100个部位、30个尺码');
 return {sizes,rows:rows.map(values=>{if(values.length!==header.length)throw new Error('CSV每行列数必须与表头一致');const d=Object.fromEntries(header.map((k,i)=>[k,values[i]]));return {key:d['部位代码'],label:d['部位名称'],method:d['测量方法'],basis:({'整围':'full','半围':'half','长度':'length'})[d['口径']]||d['口径'],unit:d['单位'],value:d['数值']||'',tolerance:d['公差']||'',step:d['单档增量']||'',values:Object.fromEntries(sizes.map(k=>[k,d[k]||'']))};})};
}
