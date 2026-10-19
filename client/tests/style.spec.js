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
  await page
    .getByLabel("本次衍生底图", { exact: true })
    .selectOption("original");
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

test("editable specification layout exports without another model call", async ({
  page,
  request,
}) => {
  const t = await makeStyle(request, "规格排版");
  const ws = await (
    await request.get(`/api/studio/templates/${t.id}/workspace`)
  ).json();
  const q = await (
    await request.post(`/api/studio/templates/${t.id}/quote`, {
      data: {
        version_id: ws.versions[0].id,
        op: "create",
        mode: "text",
        model_id: "browser-image-one",
        size: "512x512",
        count: 1,
      },
    })
  ).json();
  await request.post(`/api/studio/templates/${t.id}/jobs`, {
    data: {
      quote_id: q.quote.id,
      request_key: crypto.randomUUID(),
      confirm: true,
    },
  });
  await openStyle(page, "规格排版", true);
  await expect
    .poll(async () => {
      const ws = await (
        await request.get(`/api/studio/templates/${t.id}/workspace`)
      ).json();
      return ws.images.length;
    })
    .toBe(1);
  await page.getByRole("button", { name: "图文排版", exact: true }).click();
  await expect(page.locator(".style-layout-images label")).toHaveCount(1);
  let calls = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/jobs")) calls++;
  });
  await page.getByLabel("排版用途").selectOption("spec");
  await page.locator(".style-layout-images input").check();
  await page.getByLabel("测量项目1").fill("衣长");
  await page.getByLabel("厘米数1").fill("76.2");
  await page.locator('.style-panel nav').getByRole('button',{name:'版本记录',exact:true}).click();
  await page.getByRole('button',{name:'图文排版',exact:true}).click();
  await expect(page.getByLabel('厘米数1')).toHaveValue('76.2');
  await page.getByText("我已核对图片、文字及尺寸资料", { exact: true }).click();
  await expect(
    page.getByRole("img", { name: "可编辑图文排版", exact: true }),
  ).toContainText("30.00 in");
  await page
    .getByRole("button", { name: "保存可编辑排版", exact: true })
    .click();
  await expect(
    page.getByText("已保存排版（1）", { exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 SVG", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.svg$/);
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PNG", exact: true }).click();
  const exported = await pngDownload;
  expect(exported.suggestedFilename()).toMatch(/\.png$/);
  const meta = await sharp(await exported.path()).metadata();
  expect(meta.width).toBe(1000);
  expect(meta.height).toBe(1000);
  expect(calls).toBe(0);
});

test('clone analysis compresses its request but saves the uploaded original bytes',async({page,request})=>{
 const original=await sharp({create:{width:1400,height:900,channels:3,background:'#315274'}}).png().toBuffer();
 await page.goto('/');await page.getByText('设计台',{exact:true}).first().click();await page.getByRole('button',{name:'解析款式',exact:true}).first().click();
 await page.locator('input[type="file"]').setInputFiles({name:'source.png',mimeType:'image/png',buffer:original});
 const extraction=page.waitForRequest(r=>r.url().endsWith('/dna/extract'));await page.getByRole('button',{name:'提取 DNA',exact:true}).click();const uploaded=(await extraction).postDataJSON();const analyzed=await sharp(Buffer.from(uploaded.imageBase64,'base64')).metadata();expect(analyzed.width).toBe(1024);
 await page.getByPlaceholder('模板名称，如：香槟色鱼尾裙').fill('保留上传原始图');await page.getByRole('button',{name:'保存模板',exact:true}).click();await expect(page.locator('.studio-card').filter({hasText:'保留上传原始图'})).toBeVisible();
 const list=await (await request.get('/api/studio/templates')).json();const t=list.templates.find(t=>t.name==='保留上传原始图');const response=await request.get('/'+t.source_image_path);expect(response.ok()).toBeTruthy();expect(Buffer.compare(await response.body(),original)).toBe(0);const metadata=await sharp(await response.body()).metadata();expect(metadata.width).toBe(1400);expect(metadata.height).toBe(900);
});
