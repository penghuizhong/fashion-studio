import { expect } from "@playwright/test";
export async function derive(page) {
  const viewer = page.getByRole("button", { name: "款式衍生", exact: true });
  if (await viewer.isVisible()) await viewer.click();
  await page.locator(".wizard-steps button").nth(1).click();
  if ((await page.viewportSize()).width < 700)
    await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("图片模型", { exact: true })).not.toHaveValue(
    "",
  );
}
export async function analyze(page) {
  await page.locator(".wizard-footer .wizard-primary").click();
  const confirm = page.getByRole("dialog", {
    name: "确认商品分析费用",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await expect(
    confirm.getByRole("button", { name: "确认并分析", exact: true }),
  ).toBeEnabled();
  await confirm
    .getByRole("button", { name: "确认并分析", exact: true })
    .click();
  await expect(page.locator(".wizard-steps button").nth(2)).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(page.locator(".wizard-plan-card").first()).toBeVisible();
}
export async function render(page) {
  await expect(page.locator(".wizard-footer .wizard-primary")).toBeEnabled();
  await page.locator(".wizard-footer .wizard-primary").click();
  await expect(
    page.locator(".wizard-result-card").filter({ hasText: "成功" }).first(),
  ).toBeVisible();
}
export async function attributes(page) {
  await page.locator(".wizard-steps button").first().click();
  if ((await page.viewportSize()).width < 700)
    await page.getByRole("button", { name: "设置", exact: true }).click();
}
