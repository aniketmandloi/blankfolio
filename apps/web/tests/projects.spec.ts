import { expect, test } from "@playwright/test";

// Authenticated browser storage belongs to a synthetic account in the disposable fixture database.
// Servers are started by the operator with permission; this suite never starts them.
test("a researcher returns to a saved brief and manages its lifecycle using the keyboard", async ({
	page,
}) => {
	const title = `Browser fixture ${test.info().project.name} ${Date.now()}`;
	await page.goto("/dashboard");
	await page.getByLabel("Working title", { exact: true }).fill(title);
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+$/);
	await page
		.getByLabel("Research topic and question")
		.fill("How do representations transfer across domains?");
	await page.getByRole("button", { name: "Save brief", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByText("Saved as revision 2.", { exact: true }),
	).toBeVisible();
	await page.reload();
	await expect(page.getByLabel("Working title", { exact: true })).toHaveValue(
		title,
	);
	await expect(page.getByLabel("Research topic and question")).toHaveValue(
		"How do representations transfer across domains?",
	);
	await page
		.getByRole("button", { name: "Archive project", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Confirm archive", exact: true })
		.click();
	await expect(
		page.getByLabel("Working title", { exact: true }),
	).toBeDisabled();
	await page
		.getByRole("button", { name: "Restore project", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Confirm restore", exact: true })
		.click();
	await expect(page.getByLabel("Working title", { exact: true })).toBeEnabled();
	await page
		.getByRole("button", { name: "Delete project", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Confirm delete", exact: true })
		.click();
	await expect(page).toHaveURL(/\/dashboard$/);
	await expect(
		page.getByRole("link", { name: title, exact: true }),
	).toHaveCount(0);
});
