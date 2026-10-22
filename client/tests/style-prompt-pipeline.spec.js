import { test, expect } from "@playwright/test";
import sharp from "../../server/node_modules/sharp/lib/index.js";
import { derive, analyze } from "./wizard-helpers.js";

test("two concise fields survive reload, global edits concatenate automatically and reanalysis preserves drafts", async ({
  page,
  request,
}) => {
  const preset = (
    await (await request.get("/api/studio/dna-presets")).json()
  ).presets.find((p) => p.id === "suit");
  const template = await (
    await request.post("/api/studio/templates", {
      data: {
        name: "提示词链路验收",
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
              width: 400,
              height: 600,
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
  const open = async () => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "设计台", exact: true })
      .first()
      .click();
    await page
      .locator(".studio-card")
      .filter({ hasText: "提示词链路验收" })
      .getByRole("button", { name: "款式属性", exact: true })
      .click();
    await page.locator(".wizard-steps button").first().click();
    await expect(page.getByLabel("设计版本", { exact: true })).not.toHaveValue(
      "",
    );
  };
  const read = async () => {
    const list = await (
      await request.get(`/api/studio/templates/${template.id}/plans`)
    ).json();
    return (
      await (
        await request.get(
          `/api/studio/templates/${template.id}/plans/${list.plans[0].id}`,
        )
      ).json()
    ).plan;
  };
  await open();
  await derive(page);
  await analyze(page);
  await page.locator(".wizard-steps button").nth(1).click();
  await page.getByText("本次实际识图：1张", { exact: true }).click();
  await expect(page.getByAltText("识图来源图1", { exact: true })).toBeVisible();
  await page.locator(".wizard-steps button").nth(2).click();
  await page.locator(".wizard-plan-title").first().click();
  await expect(page.locator(".wizard-request-summary")).toContainText(
    "仅输出1张",
  );
  await expect(page.locator(".wizard-request-summary")).toContainText("图生图");

  const prompt = page.getByLabel("图片1主要描述", { exact: true });
  await expect(page.getByLabel("图片1基本属性")).not.toHaveValue("");
  await expect(prompt).not.toHaveValue(/同模块多图|款式卖点|model_/);
  await prompt.fill("字".repeat(201));
  await expect(prompt).not.toHaveValue("字".repeat(201));
  const attributes = page.getByLabel("图片1基本属性");
  await attributes.fill("黑色西装，常规版型，保留贴兜。");
  await attributes.blur();
  await prompt.fill("手工终稿：正面展示黑色西装");
  await prompt.blur();
  await expect
    .poll(async () => (await read()).content.items[0].description_prompt)
    .toBe("手工终稿：正面展示黑色西装");
  await page.getByLabel("关闭款式详情").click();
  await open();
  await page.locator(".wizard-steps button").nth(2).click();
  await page.locator(".wizard-plan-title").first().click();
  await expect(prompt).toHaveValue("手工终稿：正面展示黑色西装");
  await expect(attributes).toHaveValue("黑色西装，常规版型，保留贴兜。");
  await page.getByText("整体设计规范", { exact: true }).click();
  await page
    .getByLabel("整体设计规范", { exact: true })
    .fill("核心视觉基调：深灰背景\n全局摄影参数：侧逆光");
  await page.getByLabel("整体设计规范", { exact: true }).blur();
  await expect(page.getByRole("button", { name: "确认保留手工提示词", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await read()).content.items[0].prompt).toContain("侧逆光");
  await expect(prompt).toHaveValue("手工终稿：正面展示黑色西装");
  const before = await read();
  await page.locator(".wizard-steps button").nth(1).click();
  await page.locator(".wizard-footer .wizard-primary").click();
  await page
    .getByRole("dialog", { name: "确认商品分析费用" })
    .getByRole("button", { name: "确认并分析", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "采用新方案，替换手工修改", exact: true }),
  ).toBeVisible();
  expect((await read()).revision).toBe(before.revision);
  expect((await read()).content.items[0].description_prompt).toBe(
    "手工终稿：正面展示黑色西装",
  );
  await page
    .getByRole("button", { name: "采用新方案，替换手工修改", exact: true })
    .click();
  await expect(page.locator(".wizard-steps button").nth(2)).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect
    .poll(async () => (await read()).content.items[0].description_prompt)
    .not.toBe("手工终稿：正面展示黑色西装");
});
