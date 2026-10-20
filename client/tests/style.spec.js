import {derive,analyze,render,attributes} from './wizard-helpers.js';
import { test, expect } from "@playwright/test";
import sharp from "../../server/node_modules/sharp/lib/index.js";
async function makeStyle(request, name = "款式版本测试") {
  const p = await (await request.get("/api/studio/dna-presets")).json();
  const preset = p.presets.find((p) => p.id === "suit");
  const dna = Object.fromEntries(
    preset.fields.map((f) => [
      f.key,
      {
        value:
          f.key === "details"
            ? ["贴兜"]
            : f.key === "primary_color"
              ? "藏蓝"
              : "常规",
        confidence: 0.8,
      },
    ]),
  );
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#eeeeee"/><path d="M260 180 L180 240 L80 750 L200 790 L260 500 L250 1040 L550 1040 L540 500 L600 790 L720 750 L620 240 L540 180 L400 270 Z" fill="#223952"/><path d="M260 180 L400 600 L540 180 L400 270 Z" fill="#152638"/></svg>';
  const image = (await sharp(Buffer.from(svg)).png().toBuffer()).toString(
    "base64",
  );
  const r = await request.post("/api/studio/templates", {
    data: {
      name,
      preset_id: "suit",
      dna_json: dna,
      source_image_base64: image,
    },
  });
  expect(r.ok()).toBeTruthy();
  return { ...(await r.json()), dna };
}
async function openStyle(page, name, properties = true, mobile = false) {
  await page.goto("/");
  if (mobile)
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await page.getByText("设计台", { exact: true }).first().click();
  const card = page.locator(".studio-card").filter({ hasText: name });
  if (properties)
    await card.getByRole("button", { name: "款式属性", exact: true }).click();
  else await card.click();
  await expect(
    page.getByRole("dialog", { name: "款式详情", exact: true }),
  ).toBeVisible();
}

test('same dialog, immutable edits, branches, persistent drafts and independent generation',async({page,request})=>{
 const t=await makeStyle(request,'不可变版本');await openStyle(page,'不可变版本',false);const modal=page.getByRole('dialog',{name:'款式详情',exact:true});await expect(modal.locator('.wizard-steps button').first()).toHaveAttribute('aria-current','step');await expect(modal.locator('.wizard-image-only')).toHaveCount(0);
 await page.getByRole('button',{name:'基于此版本修改',exact:true}).click();await page.getByLabel('属性主色',{exact:true}).fill('酒红');await page.getByLabel('属性面料外观',{exact:true}).fill('亚麻');await page.getByRole('button',{name:'保存为新版本',exact:true}).click();await expect(page.getByText('已保存为 V2，原属性与图片保留',{exact:true})).toBeVisible();
 let ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();expect(ws.versions.length).toBe(2);expect(JSON.parse(ws.versions.find(v=>v.number===1).dna_json).primary_color.value).toBe('藏蓝');expect(JSON.parse(ws.versions.find(v=>v.number===2).dna_json).primary_color.value).toBe('酒红');expect(ws.template.work_version_id).toBe(ws.versions.find(v=>v.number===1).id);
 await expect(page.getByText(/当前版本尚未生成/)).toBeVisible();await derive(page);await analyze(page);await render(page);ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();expect(ws.images[0].design_version_id).toBe(ws.versions.find(v=>v.number===2).id);expect(ws.template.cover_generation_id).toBe(null);
 await page.locator('.wizard-result-card').first().getByRole('button',{name:'设为封面',exact:true}).click();await expect.poll(async()=>((await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json()).template.cover_generation_id)).not.toBe(null);
 await attributes(page);await page.getByRole('button',{name:'基于此版本修改',exact:true}).click();await page.getByLabel('属性主色',{exact:true}).fill('墨绿');await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);await page.locator('.studio-card').filter({hasText:'不可变版本'}).getByRole('button',{name:'款式属性',exact:true}).click();await expect(page.getByLabel('属性主色',{exact:true})).toHaveValue('墨绿');await page.getByRole('button',{name:'取消修改',exact:true}).click();
 const first=ws.versions.find(v=>v.number===1).id;await page.getByLabel('设计版本',{exact:true}).selectOption(String(first));await page.getByRole('button',{name:'基于此版本修改',exact:true}).click();await page.getByLabel('属性主色',{exact:true}).fill('深灰');await page.getByRole('button',{name:'保存为新版本',exact:true}).click();await expect(page.getByText(/已保存为 V3/)).toBeVisible();ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();expect(ws.versions.find(v=>v.number===3).parent_id).toBe(first);
});

test('saved recolor/detail versions and scene presentation keep design boundaries',async({page,request})=>{
 const t=await makeStyle(request,'换色与场景');await openStyle(page,'换色与场景');await page.getByRole('button',{name:'基于此版本修改',exact:true}).click();await page.getByLabel('属性主色',{exact:true}).fill('酒红');await page.getByRole('button',{name:'保存为新版本',exact:true}).click();await derive(page);await analyze(page);await render(page);
 await page.locator('.wizard-footer .wizard-primary').click();await page.getByLabel('生成要求').fill('简洁的室内场景，服装颜色不变');await analyze(page);await render(page);const ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();expect(ws.versions).toHaveLength(2);expect(ws.jobs).toHaveLength(2);expect(ws.jobs[0].snapshot.style.version_id).toBe(ws.jobs[1].snapshot.style.version_id);
});

test('retired layout stays absent and original downloads stay exact',async({page,request})=>{
 const t=await makeStyle(request,'排版功能下线');const calls=[];page.on('request',r=>{if(/layouts|layoutImages/.test(r.url()))calls.push(r.url());});await openStyle(page,'排版功能下线');await expect(page.locator('.wizard-steps button')).toHaveCount(5);await expect(page.getByRole('button',{name:'图文排版',exact:true})).toHaveCount(0);const download=page.waitForEvent('download');await page.locator('.wizard-property-preview').getByRole('link',{name:'下载原图',exact:true}).click();expect((await download).suggestedFilename()).toMatch(/\.png$/);expect(calls).toEqual([]);expect((await request.post(`/api/studio/templates/${t.id}/layouts`,{data:{}})).status()).toBe(410);expect((await request.get(`/api/studio/templates/${t.id}/workspace/layouts`)).status()).toBe(410);
});

test('unified references, custom native output, quality and saved design note',async({page,request})=>{
 const t=await makeStyle(request,'统一参考与输出');await openStyle(page,'统一参考与输出');await page.getByRole('button',{name:'基于此版本修改',exact:true}).click();await page.getByLabel('设计变化说明').fill('衣领改成条纹，保留整体版型');await page.getByRole('button',{name:'保存为新版本',exact:true}).click();await derive(page);await page.getByLabel('图片模型',{exact:true}).selectOption('browser-image-two');await page.getByLabel('图片尺寸',{exact:true}).selectOption('custom');await page.getByLabel('自定义宽').fill('800');await page.getByLabel('自定义高').fill('1200');await page.getByLabel('生成质量',{exact:true}).selectOption('high');await page.getByLabel('生成要求').fill('用参考图作为主体，完整展示服装');await analyze(page);await render(page);const ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();expect(ws.jobs[0].snapshot.size).toBe('800x1200');expect(ws.jobs[0].snapshot.quality).toBe('high');expect(ws.jobs[0].snapshot.style.design_note).toContain('条纹');expect(ws.versions).toHaveLength(2);expect(ws.images).toHaveLength(1);
});

test('asset library has independent archive and recycle tabs and safe permanent removal',async({page,request})=>{
 const t=await makeStyle(request,'资产生命周期');
 let ws=await (await request.get(`/api/studio/templates/${t.id}/workspace`)).json();
 const q=await (await request.post(`/api/studio/templates/${t.id}/quote`,{data:{version_id:ws.template.work_version_id,op:'create',mode:'text',model_id:'browser-image-one',size:'512x512',count:1}})).json();
 expect(q.ok).toBeTruthy();
 const started=await request.post(`/api/studio/templates/${t.id}/jobs`,{data:{quote_id:q.quote.id,request_key:crypto.randomUUID(),confirm:true}});expect(started.ok()).toBeTruthy();
 await expect.poll(async()=>{ws=await (await request.get(`/api/studio/templates/${t.id}/workspace`)).json();return ws.images.length;}).toBe(1);
 const image=ws.images[0],bytes=await (await request.get('/'+image.image_path)).body();
 await page.goto('/');await page.getByText('资产库',{exact:true}).first().click();
 const card=page.locator('.asset-card').filter({hasText:'资产生命周期'});
 await card.getByRole('button',{name:`图片${image.id}操作菜单`,exact:true}).click();
 await card.getByRole('menuitem',{name:'归档',exact:true}).click();
 await expect(card).toHaveCount(0);
 const tabs=page.getByRole('group',{name:'内容状态'});
 await tabs.getByRole('button',{name:'已归档',exact:true}).click();await expect(card).toBeVisible();
 await card.getByRole('button',{name:`图片${image.id}操作菜单`,exact:true}).click();
 await card.getByRole('menuitem',{name:'删除（移入回收站）',exact:true}).click();
 await tabs.getByRole('button',{name:'回收站',exact:true}).click();await expect(card).toBeVisible();
 await card.getByRole('button',{name:`图片${image.id}操作菜单`,exact:true}).click();
 await card.getByRole('menuitem',{name:'永久删除',exact:true}).click();
 const confirm=page.getByRole('dialog',{name:'永久移除确认'});
 await confirm.getByLabel('永久删除确认').fill('永久删除');await confirm.getByRole('button',{name:'永久移除此记录'}).click();
 await expect(confirm).toContainText('记录已永久移除');
 await confirm.getByRole('button',{name:'清理未引用文件'}).click();
 await expect(page.getByText('文件仍被其他内容或历史任务引用，已保留',{exact:true})).toBeVisible();
 expect(await (await request.get('/'+image.image_path)).body()).toEqual(bytes);
});
