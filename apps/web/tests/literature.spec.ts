import { expect, test } from "@playwright/test";

// Needs the web app, API and `pnpm dev:worker` running against a disposable fixture database,
// started by the operator with permission; this suite never starts them.
test("a researcher saves a Literature Scope, confirms the exact queries and returns to a dated snapshot", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.goto("/dashboard");
	await page
		.getByLabel("Working title", { exact: true })
		.fill(`Literature fixture ${test.info().project.name} ${Date.now()}`);
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+$/);
	await page
		.getByLabel("Research topic and question")
		.fill("tabular transfer fixture:metered-partial");
	await page.getByRole("button", { name: "Save brief", exact: true }).click();
	await page.getByRole("link", { name: /Review literature scope/ }).click();
	await expect(page).toHaveURL(/\/literature$/);

	await expect(page.getByLabel("Query 1")).toHaveValue(
		"tabular transfer fixture:metered-partial",
	);
	await page.getByRole("checkbox", { name: /Fixture metered index/ }).check();
	await page.getByRole("button", { name: "Save scope", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByText("Saved as scope revision 1.")).toBeVisible();

	await page.getByRole("button", { name: "Review and search" }).click();
	await expect(
		page.getByRole("group", { name: "Confirm search" }).getByRole("listitem"),
	).toHaveText([
		"tabular transfer fixture:metered-partial",
		/^Literature fixture/,
	]);
	await page.getByRole("button", { name: "Send these queries" }).click();
	await expect(page.getByText(/Queued|Searching/).first()).toBeVisible();

	await page.goto("/dashboard");
	await page.goBack();
	await expect(page.getByText("Snapshot saved").first()).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("button", { name: "View snapshot" }).first().click();
	await expect(page.getByText(/Partial coverage/)).toBeVisible();
	await expect(page.getByText("Partial answer")).toBeVisible();
	await expect(
		page.getByText(/reserved for later arXiv and status checks/),
	).toBeVisible();
	await expect(page.getByText(/^Preprint · /).first()).toBeVisible();
	await expect(page.getByText(/Metadata only/).first()).toBeVisible();
	await expect(
		page.getByRole("link", { name: /^doi:10\.5555\/fixture\./ }).first(),
	).toHaveAttribute("href", /^https:\/\/doi\.org\/10\.5555\/fixture\./);
	const width = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(width).toBeLessThanOrEqual(0);
});
