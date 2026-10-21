import { test, expect } from "@playwright/test";
import sharp from "../../server/node_modules/sharp/lib/index.js";

test("selling layout previews source crops, edits exact copy and requires result review", async ({
  page,
  request,
}) => {
  const preset = (
    await (await request.get("/api/studio/dna-presets")).json()
  ).presets.find((p) => p.id === "suit");
  const template = await (
    await request.post("/api/studio/templates", {
      data: {
        name: "商品细节排版验收",
        preset_id: "suit",
        dna_json: Object.fromEntries(
          preset.fields.map((f) => [
            f.key,
            { value: f.key === "details" ? ["贴兜"] : "常规", confidence: 0.8 },
          ]),
        ),
        source_image_base64: (
          await sharp({
            create: {
              width: 800,
              height: 1200,
              channels: 3,
              background: "#456789",
            },
          })
            .png()
            .toBuffer()
        ).toString("base64"),
      },
    })
  ).json();
  const base = `/api/studio/templates/${template.id}/plans`;
  let plan = (
    await (
      await request.post(base, {
        data: {
          request_key: crypto.randomUUID(),
          version_id: template.work_version_id,
          input: {
            generation_mode: "product",
            modules: { selling: 1 },
            references: [
              { id: "original-product", source: "original", role: "garment" },
            ],
            model_id: "browser-image-one",
            size: "1024x1024",
          },
        },
      })
    ).json()
  ).plan;
  expect(plan).toBeTruthy();
  plan.content.items[0].manual_confirmed = true;
  plan.content.items[0].layout = {
    headline: "原图结构细节",
    subtitle: "按真实商品核对",
    main_reference_id: "original-product",
    main_crop: { x: 0, y: 0, width: 1, height: 1 },
    details: [
      {
        title: "领口设计",
        body: "原图裁切，保持原样",
        reference_id: "original-product",
        crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
        confirmed: true,
      },
    ],
  };
  expect(
    (
      await request.put(`${base}/${plan.id}`, {
        data: { expected_revision: plan.revision, content: plan.content },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto("/");
  await page
    .getByRole("button", { name: "设计台", exact: true })
    .first()
    .click();
  await page
    .locator(".studio-card")
    .filter({ hasText: "商品细节排版验收" })
    .getByRole("button", { name: "款式属性", exact: true })
    .click();
  await page.locator(".wizard-steps button").nth(2).click();
  await page.locator(".wizard-plan-title").first().click();
  await expect(page.getByLabel("卖点1标题", { exact: true })).toHaveValue(
    "领口设计",
  );
  await page
    .getByRole("button", { name: "预览排版（不调用模型）", exact: true })
    .click();
  await expect(page.getByAltText("原图细节与中文排版预览")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page
      .locator(".style-wizard")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.getByLabel("主展示位置", { exact: true }).selectOption("right");
  await page.getByLabel("区域留白", { exact: true }).fill("32");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByLabel("卖点1说明", { exact: true })
    .fill("逐字修改，无需重画服装");
  await expect(
    page.getByLabel("已核对来源、裁切和文案", { exact: true }),
  ).not.toBeChecked();
  await expect(page.locator(".wizard-footer .wizard-primary")).toBeDisabled();
  await page.getByLabel("已核对来源、裁切和文案", { exact: true }).check();
  await expect(page.locator(".wizard-footer .wizard-primary")).toBeEnabled();
  await page.locator(".wizard-footer .wizard-primary").click();
  await expect(
    page.getByText("已生成 · 待验收", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "对照原图验收", exact: true }).click();
  const section = page
    .locator(".wizard-section")
    .filter({
      has: page.getByRole("button", { name: "收起验收", exact: true }),
    })
    .last();
  await expect(section.getByAltText("实际使用的商品参考图")).toBeVisible();
  for (const checkbox of await section.locator("input[type=checkbox]").all())
    await checkbox.check();
  await section
    .getByRole("button", { name: "保存为已验收", exact: true })
    .click();
  await expect(page.getByText("已逐项验收", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "修改细节裁切与文案，再次排版", exact: true })
    .click();
  await expect(page.locator(".wizard-steps button").nth(2)).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.locator(".wizard-plan-title").first().click();
  await expect(page.getByLabel("卖点1说明", { exact: true })).toHaveValue(
    "逐字修改，无需重画服装",
  );
});
