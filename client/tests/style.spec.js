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

test("same dialog, immutable edits, branch, draft and separate generation", async ({
  page,
  request,
}) => {
  const t = await makeStyle(request, "不可变版本");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openStyle(page, "不可变版本", false);
  const dialog = page.getByRole("dialog", { name: "款式详情", exact: true });
  const handle = await dialog.elementHandle();
  await dialog.getByRole("button", { name: "款式属性", exact: true }).click();
  expect(await dialog.evaluate((el, old) => el === old, handle)).toBe(true);
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await page.getByLabel("属性主色", { exact: true }).fill("酒红");
  await page.getByLabel("属性面料外观", { exact: true }).fill("亚麻");
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(page.getByLabel("设计版本", { exact: true })).toContainText(
    "V2",
  );
  let ws = await (
    await request.get(`/api/studio/templates/${t.id}/workspace`)
  ).json();
  expect(ws.versions.length).toBe(2);
  expect(
    JSON.parse(ws.versions.find((v) => v.number === 1).dna_json).primary_color
      .value,
  ).toBe("藏蓝");
  expect(JSON.parse(ws.versions[0].dna_json).primary_color.value).toBe("酒红");
  expect(ws.template.work_version_id).toBe(
    ws.versions.find((v) => v.number === 1).id,
  );
  await expect(page.locator(".style-empty")).toContainText("尚未生成");
  await page
    .locator(".style-panel nav")
    .getByRole("button", { name: "款式衍生", exact: true })
    .click();
  await expect(page.getByLabel("款式图片模型")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认费用并生成", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "确认费用并生成", exact: true })
    .click();
  await expect(page.locator(".style-result-grid article")).toHaveCount(1);
  ws = await (
    await request.get(`/api/studio/templates/${t.id}/workspace`)
  ).json();
  expect(ws.images[0].design_version_id).toBe(ws.versions[0].id);
  expect(ws.template.cover_generation_id).toBe(null);
  await page
    .locator(".style-result-grid article details")
    .first()
    .getByText("更多操作", { exact: true })
    .click();
  await page.getByRole("button", { name: "设为展示图", exact: true }).click();
  await expect(page.locator(".style-result-grid")).toContainText("展示图");
  await page
    .locator(".style-panel nav")
    .getByRole("button", { name: "款式属性", exact: true })
    .click();
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await page.getByLabel("属性主色", { exact: true }).fill("墨绿");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "保留草稿并关闭", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "保留草稿并关闭", exact: true })
    .click();
  await page
    .locator(".studio-card")
    .filter({ hasText: "不可变版本" })
    .getByRole("button", { name: "款式属性", exact: true })
    .click();
  await expect(page.getByLabel("属性主色", { exact: true })).toHaveValue(
    "墨绿",
  );
  expect(errors).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 720, height: 450 },
  { width: 390, height: 844 },
  { width: 375, height: 667 },
])
  test(`style layout and original remain visible ${viewport.width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    await makeStyle(request, `布局${viewport.width}`);
    await openStyle(page, `布局${viewport.width}`, true, viewport.width < 769);
    const dialog = page.getByRole("dialog", { name: "款式详情", exact: true });
    await page
      .locator(".style-panel-body")
      .evaluate((e) => (e.scrollTop = e.scrollHeight));
    for (const element of [
      page.getByRole("button", { name: "关闭款式详情", exact: true }),
      page.locator(".style-workspace-footer"),
    ]) {
      const b = await element.boundingBox();
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    expect(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    expect(
      await page
        .locator(".style-preview-image img")
        .evaluate((e) => getComputedStyle(e).objectFit),
    ).toBe("contain");
    const imageBox = await page
        .locator(".style-preview-image img")
        .boundingBox(),
      previewBox = await page.locator(".style-preview-image").boundingBox();
    expect(imageBox.y).toBeGreaterThanOrEqual(previewBox.y);
    expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(
      previewBox.y + previewBox.height + 1,
    );
    await page.getByRole("button", { name: "放大原图", exact: true }).click();
    await expect(page.locator(".original-image-viewer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(page.locator(".original-image-viewer")).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/style-workspace-${viewport.width}.png`,
      animations: "disabled",
    });
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "black"),
    );
    await page.screenshot({
      path: `/tmp/style-workspace-${viewport.width}-dark.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

test("recolor saves design first, detail camera changes and background requests keep version", async ({
  page,
  request,
}) => {
  const t = await makeStyle(request, "动作测试");
  await openStyle(page, "动作测试", true);
  await page
    .locator(".style-panel nav")
    .getByRole("button", { name: "款式衍生", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "换色 指定部位与目标颜色，保存为新版本",
      exact: true,
    })
    .click();
  await expect(page.locator('.reference-strip article').first()).toContainText('图1 · 款式主体');
  await page.getByLabel("目标颜色（名称或色号）", { exact: true }).fill("酒红");
  await expect(
    page.getByRole("button", { name: "确认费用并生成", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "保存变化为新版本", exact: true })
    .click();
  await expect(page.getByLabel("设计版本")).toContainText("V2");
  await expect(
    page.getByRole("button", { name: "确认费用并生成", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", {
      name: "出细节图 指定局部取景，AI 推演不代表真实工艺",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("取景范围")).toHaveValue("detail");
  await page.getByLabel("特写部位").fill("左袖口");
  await expect(
    page.getByRole("button", { name: "确认费用并生成", exact: true }),
  ).toBeEnabled();
  const quoteReq = page.waitForRequest((r) => r.url().endsWith("/jobs"));
  await page
    .getByRole("button", { name: "确认费用并生成", exact: true })
    .click();
  await quoteReq;
  await expect(page.locator(".style-result-grid article")).toHaveCount(1);
  const ws = await (
    await request.get(`/api/studio/templates/${t.id}/workspace`)
  ).json();
  expect(ws.versions.length).toBe(2);
  expect(ws.jobs[0].snapshot.camera.detail).toBe("左袖口");
  expect(ws.jobs[0].snapshot.style.op).toBe("detail_shot");
});

test('retired layout has no entry or requests; legacy draft is ignored and original download remains',async({page,request})=>{
 const t=await makeStyle(request,'排版功能下线');
 await page.goto('/');await page.evaluate(id=>sessionStorage.setItem(`style-draft-layout-v1:local:${id}:1`,JSON.stringify({savedAt:Date.now(),form:{type:'spec'}})),t.id);
 const calls=[];page.on('request',r=>{if(/layouts|layoutImages/.test(r.url()))calls.push(r.url());});
 await openStyle(page,'排版功能下线',true);
 await expect(page.locator('.style-panel nav button')).toHaveCount(3);
 await expect(page.getByRole('button',{name:'图文排版',exact:true})).toHaveCount(0);
 await page.locator('.style-panel nav').getByRole('button',{name:'版本记录',exact:true}).click();
 await expect(page.getByRole('heading',{name:'设计版本',exact:true})).toBeVisible();
 const download=page.waitForEvent('download');await page.locator('.style-toolbar').getByRole('link',{name:'下载原图',exact:true}).click();
 expect((await download).suggestedFilename()).toMatch(/\.png$/);expect(calls).toEqual([]);
 expect((await request.post(`/api/studio/templates/${t.id}/layouts`,{data:{}})).status()).toBe(410);
 expect((await request.get(`/api/studio/templates/${t.id}/workspace/layouts`)).status()).toBe(410);
});

test('unified references, custom native output, quality and saved text design version',async({page,request})=>{
 const t=await makeStyle(request,'统一参考与输出');
 await openStyle(page,'统一参考与输出',true);
 const dialog=page.getByRole('dialog',{name:'款式详情'});
 await dialog.locator('nav').getByRole('button',{name:'款式衍生',exact:true}).click();
 await expect(page.getByLabel('生成方式',{exact:true})).toHaveCount(0);
 await page.getByLabel('款式图片模型').selectOption('browser-image-two');
 await page.getByRole('button',{name:'从图库选择',exact:true}).click();
 await page.getByRole('button',{name:'选择原始参考图',exact:true}).click();
 await page.getByRole('button',{name:'添加所选参考图',exact:true}).click();
 const buffer=await sharp({create:{width:512,height:512,channels:3,background:'#678912'}}).png().toBuffer();
 await page.getByLabel('上传参考图').setInputFiles({name:'sleeve.png',mimeType:'image/png',buffer});
 await expect(page.getByText('图2',{exact:true})).toBeVisible();
 await page.getByLabel('前移参考图2').click();
 await expect(page.locator('.reference-strip article').first()).toContainText('图1 · 款式主体');
 await page.getByLabel('图片尺寸',{exact:true}).selectOption('custom');
 await page.getByLabel('自定义宽').fill('800');
 await page.getByLabel('自定义高').fill('1200');
 await page.getByLabel('生成质量').selectOption('high');
 await page.getByRole('button',{name:'自由衍生 按文字或多张参考图探索新设计',exact:true}).click();
 await page.getByLabel('本次要求',{exact:true}).fill('图1的袖子，保留图2领子，改成条纹花色');
 await expect(page.getByRole('button',{name:'保存要求为新版本'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'确认费用并生成',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'确认费用并生成',exact:true}).click();
 await expect(page.locator('.style-result-grid article')).toHaveCount(1);
 const ws=await (await request.get(`/api/studio/templates/${t.id}/workspace`)).json();
 expect(ws.versions[0].design_note).toContain('条纹花色');
 expect(ws.versions[1].design_note).toBe('');
 expect(ws.jobs[0].snapshot.quality).toBe('high');
 expect(ws.jobs[0].snapshot.size).toBe('800x1200');
 expect(ws.jobs[0].snapshot.style.references[0].path).toBe(ws.template.source_image_path);
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
