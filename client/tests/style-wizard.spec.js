import { test, expect } from "@playwright/test";
import sharp from "../../server/node_modules/sharp/lib/index.js";
async function make(request, name) {
  const p = (
    await (await request.get("/api/studio/dna-presets")).json()
  ).presets.find((p) => p.id === "suit");
  const dna = Object.fromEntries(
    p.fields.map((f) => [
      f.key,
      { value: f.key === "details" ? ["贴兜"] : "常规", confidence: 0.8 },
    ]),
  );
  const bytes = await sharp({
    create: { width: 800, height: 1200, channels: 3, background: "#345678" },
  })
    .png()
    .toBuffer();
  const t = await (
    await request.post("/api/studio/templates", {
      data: {
        name,
        preset_id: "suit",
        dna_json: dna,
        source_image_base64: bytes.toString("base64"),
      },
    })
  ).json();
  return { ...t, dna, bytes };
}
async function open(page, name, width = 1440) {
  await page.setViewportSize({ width, height: 950 });
  await page.goto("/");
  if (width < 769)
    await page
      .getByRole("button", { name: "打开侧边栏", exact: true })
      .first()
      .click();
  await page
    .getByRole("button", { name: "设计台", exact: true })
    .first()
    .click();
  await page
    .locator(".studio-card")
    .filter({ hasText: name })
    .getByRole("button", { name: "款式属性", exact: true })
    .click();
  await expect(page.locator(".style-wizard")).toBeVisible();
  await expect(page.getByLabel("设计版本", { exact: true })).not.toHaveValue(
    "",
  );
}
const next = (page) =>
  page
    .locator(".wizard-footer")
    .getByRole("button", { name: "下一步", exact: true });
async function settings(page) {
  await next(page).click();
  await expect(page.getByLabel("图片模型", { exact: true })).not.toHaveValue(
    "",
  );
  await expect(
    page
      .locator(".wizard-footer")
      .getByRole("button", { name: "重新分析商品", exact: true }),
  ).toBeEnabled();
}
async function analyze(page) {
  await page.locator(".wizard-footer .wizard-primary").click();
  const confirm = page.getByRole("dialog", { name: "确认商品分析费用" });
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole("button", { name: "确认并分析", exact: true })
    .click();
  await expect(page.locator(".wizard-steps button").nth(2)).toHaveAttribute(
    "aria-current",
    "step",
  );
}
for (const width of [1440, 390])
  test(`five-step planning, prompts, generation and original results ${width}`, async ({
    page,
    request,
  }) => {
    const t = await make(request, `五步操作${width}`),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await open(page, `五步操作${width}`, width);
    await settings(page);
    await page
      .getByRole("button", { name: "增加主图展示", exact: true })
      .click();
    await expect(
      page.getByText("已选1类，共2张", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("生成要求", { exact: true })
      .fill("保留颜色，完整展示西装，背景简洁");
    await analyze(page);
    if (width < 700)
      await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(page.locator(".wizard-plan-card")).toHaveCount(2);
    await page.locator(".wizard-plan-title").first().click();
    await page.getByLabel("图片1画面要求").fill("正面完整展示，突出肩部轮廓");
    await page.getByText("模块化提示词 · 自动编译", { exact: true }).click();
    await page
      .getByLabel("图片1图片目标提示词")
      .fill("人工编辑：服装完整，主体居中");
    await expect(page.getByLabel("图片1完整提示词")).toHaveValue(/人工编辑/);
    await page.getByText("整体设计规范", { exact: true }).click();
    await page
      .getByLabel("拍摄一致性", { exact: true })
      .fill("统一柔光与中性背景");
    await expect(page.getByLabel("图片1完整提示词")).toHaveValue(/统一柔光/);
    await expect(page.getByLabel("图片1图片目标提示词")).toHaveValue(
      "人工编辑：服装完整，主体居中",
    );
    await expect(page.locator(".wizard-footer .wizard-primary")).toBeEnabled();
    await page.screenshot({
      path: `/tmp/style-wizard-plan-${width}.png`,
      animations: "disabled",
    });
    await page.locator(".wizard-footer .wizard-primary").click();
    await expect(
      page.locator(".wizard-result-grid").first().locator("article"),
    ).toHaveCount(2);
    await expect(page.locator(".wizard-result-card").first()).toContainText(
      "成功",
    );
    const ws = await (
      await request.get(`/api/studio/templates/${t.id}/workspace`)
    ).json();
    expect(ws.versions.length).toBe(1);
    expect(ws.images.length).toBe(2);
    expect(
      ws.images.every((i) => JSON.parse(i.settings_json).plan_item_id),
    ).toBe(true);
    expect(errors).toEqual([]);
    for (const theme of ["black", "white"]) {
      await page.evaluate(
        (t) => (document.documentElement.dataset.theme = t),
        theme,
      );
      expect(
        await page
          .locator(".style-wizard")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      const close = await page.getByLabel("关闭款式详情").boundingBox();
      expect(close.y).toBeGreaterThanOrEqual(0);
      await page.screenshot({
        path: `/tmp/style-wizard-results-${width}-${theme}.png`,
        animations: "disabled",
      });
    }
    expect(
      await (
        await request.get("/" + ws.template.source_image_path + "?download=1")
      ).body(),
    ).toEqual(t.bytes);
  });
test("version edits stay immutable, no-image labeling and drafts survive reopening", async ({
  page,
  request,
}) => {
  const t = await make(request, "五步版本");
  await open(page, "五步版本");
  await page
    .getByRole("button", { name: "基于此版本修改", exact: true })
    .click();
  await page.getByLabel("属性主色", { exact: true }).fill("酒红");
  await expect(next(page)).toBeDisabled();
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(
    page.getByText("当前版本尚未生成 · 下图仅供参考", { exact: true }),
  ).toBeVisible();
  const ws = await (
    await request.get(`/api/studio/templates/${t.id}/workspace`)
  ).json();
  expect(ws.versions.length).toBe(2);
  expect(JSON.parse(ws.versions.find((v) => v.number === 1).dna_json)).toEqual(
    t.dna,
  );
  await page
    .getByRole("button", { name: "基于此版本修改", exact: true })
    .click();
  await page.getByLabel("属性主色", { exact: true }).fill("墨绿");
  await page.getByLabel("关闭款式详情").click();
  await page
    .locator(".studio-card")
    .filter({ hasText: "五步版本" })
    .getByRole("button", { name: "款式属性", exact: true })
    .click();
  await expect(page.getByLabel("属性主色", { exact: true })).toHaveValue(
    "墨绿",
  );
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(
    page.getByText("已保存为 V3，原属性与图片保留", { exact: true }),
  ).toBeVisible();
  const restored = await (
    await request.get(`/api/studio/templates/${t.id}/workspace`)
  ).json();
  expect(restored.versions.find((v) => v.number === 3).parent_id).toBe(
    ws.versions.find((v) => v.number === 2).id,
  );
  expect(
    JSON.parse(restored.versions.find((v) => v.number === 3).dna_json)
      .primary_color.value,
  ).toBe("墨绿");
});
test("returning, editing and composition previews do not call analysis or generation; resume planning", async ({
  page,
  request,
}) => {
  await make(request, "五步恢复");
  await open(page, "五步恢复");
  await settings(page);
  await analyze(page);
  let paid = 0;
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      /\/(analyze|jobs)$/.test(new URL(r.url()).pathname)
    )
      paid++;
  });
  await page.getByRole("button", { name: "构图预览", exact: true }).click();
  await expect(page.getByText(/构图示意 · 不调用图片模型/)).toBeVisible();
  await page
    .locator(".wizard-footer")
    .getByRole("button", { name: "上一步", exact: true })
    .click();
  await page.getByLabel("生成要求").fill("保留已保存设计，改用室内背景");
  await page.getByLabel("关闭款式详情").click();
  await page
    .locator(".studio-card")
    .filter({ hasText: "五步恢复" })
    .getByRole("button", { name: "款式属性", exact: true })
    .click();
  await expect(page.getByLabel("生成要求")).toHaveValue(
    "保留已保存设计，改用室内背景",
  );
  expect(paid).toBe(0);
});

test("lost analysis response recovers the original task after reopening", async ({
  page,
  request,
}) => {
  const t = await make(request, "分析断网恢复");
  await open(page, "分析断网恢复");
  await settings(page);
  const bodies = [];
  let lost = true;
  await page.route("**/plans/*/analyze", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.locator(".wizard-footer .wizard-primary").click();
  await page
    .getByRole("dialog", { name: "确认商品分析费用" })
    .getByRole("button", { name: "确认并分析", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "核对分析结果", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("关闭款式详情").click();
  await page
    .locator(".studio-card")
    .filter({ hasText: "分析断网恢复" })
    .getByRole("button", { name: "款式属性", exact: true })
    .click();
  await page.getByRole("button", { name: "核对分析结果", exact: true }).click();
  await expect(page.locator(".wizard-steps button").nth(2)).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  const list = await (
    await request.get(`/api/studio/templates/${t.id}/plans`)
  ).json();
  const full = await (
    await request.get(`/api/studio/templates/${t.id}/plans/${list.plans[0].id}`)
  ).json();
  expect(full.analyses).toHaveLength(1);
});

test("concurrent planning edits merge local changes with unrelated remote changes", async ({
  page,
  request,
}) => {
  const t = await make(request, "规划合并");
  await open(page, "规划合并");
  await settings(page);
  await analyze(page);
  const list = await (
    await request.get(`/api/studio/templates/${t.id}/plans`)
  ).json();
  const url = `/api/studio/templates/${t.id}/plans/${list.plans[0].id}`;
  const p = (await (await request.get(url)).json()).plan;
  const content = structuredClone(p.content);
  content.standard.photography = "远端确认的柔光摄影";
  const result = await request.put(url, {
    data: { expected_revision: p.revision, content },
  });
  expect(result.ok()).toBe(true);
  await page.locator(".wizard-plan-title").first().click();
  await page.getByLabel("图片1画面要求").fill("本机调整的完整正面展示");
  await expect(page.locator(".wizard-footer [role=alert]")).toContainText(
    "规划已更新",
  );
  await page
    .getByRole("button", { name: "查看并合并草稿", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "合并规划草稿",
    exact: true,
  });
  await expect(dialog).toContainText("未发现同字段冲突");
  await dialog
    .getByRole("button", { name: "合并双方修改", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const merged = (await (await request.get(url)).json()).plan;
  expect(merged.content.standard.photography).toBe("远端确认的柔光摄影");
  expect(merged.content.items[0].requirement).toBe("本机调整的完整正面展示");
});

test("bulk download stores original image bytes in a ZIP file", async ({
  page,
  request,
}) => {
  const t = await make(request, "原图打包");
  await open(page, "原图打包");
  await settings(page);
  await analyze(page);
  await page.locator(".wizard-footer .wizard-primary").click();
  await expect(page.locator(".wizard-result-card").first()).toContainText(
    "成功",
  );
  await page
    .getByRole("checkbox", { name: /选择下载/ })
    .first()
    .check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /下载所选原图/ }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/\.zip$/);
  const { readFile } = await import("node:fs/promises");
  const zip = await readFile(await d.path());
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const length = zip.readUInt32LE(18),
    start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  const ws = await (
    await request.get(`/api/studio/templates/${t.id}/workspace`)
  ).json();
  expect(zip.subarray(start, start + length)).toEqual(
    await (
      await request.get("/" + ws.images[0].image_path + "?download=1")
    ).body(),
  );
});

test("analysis thinking is an explicit switch and fixed reasoning models show their actual behavior", async ({
  page,
  request,
}) => {
  await make(request, "分析思考设置");
  await open(page, "分析思考设置");
  await settings(page);
  const toggle = page.getByRole("checkbox", { name: /思考模式/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByLabel("移除参考图1").click();
  await page
    .getByLabel("商品分析模型", { exact: true })
    .selectOption("browser-reasoner");
  await expect(
    page.getByText("此模型固定启用思考，分析可能较慢。", { exact: true }),
  ).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await page.locator(".wizard-footer .wizard-primary").click();
  const dialog = page.getByRole("dialog", { name: "确认商品分析费用" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "款式详情", exact: true }),
  ).toBeVisible();
});
