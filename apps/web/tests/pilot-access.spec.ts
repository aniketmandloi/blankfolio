import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

// Requires servers started with permission, a disposable fixture database shared by the API
// and apps/server/.env, and API AUTH_MAIL_OUTBOX equal to PLAYWRIGHT_MAIL_OUTBOX. No mail is sent.
test.use({ storageState: { cookies: [], origins: [] } });

const password = "Disposable-browser-Password-123!";
const address = (name: string) =>
	`${name}-${test.info().project.name}-${Date.now()}@example.test`;

function invite(email: string) {
	execFileSync(
		"pnpm",
		[
			"--filter",
			"server",
			"pilot:access",
			"invite",
			email,
			"--actor",
			"playwright-fixture",
			"--reason",
			"Synthetic browser check",
		],
		{ stdio: "ignore" },
	);
}

async function latestLink(email: string, kind: string) {
	const outbox = process.env.PLAYWRIGHT_MAIL_OUTBOX;
	if (!outbox) throw new Error("Set PLAYWRIGHT_MAIL_OUTBOX to the API outbox");
	let url: string | undefined;
	await expect
		.poll(async () => {
			url = (await readFile(outbox, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as { kind: string; to: string; url: string },
				)
				.findLast((mail) => mail.to === email && mail.kind === kind)?.url;
			return url;
		})
		.toBeTruthy();
	return url as string;
}

async function signIn(page: Page, email: string, secret = password) {
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(secret);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function registerAndVerify(page: Page, email: string) {
	await page.goto("/login");
	await page.getByRole("button", { name: "Need an account? Sign up" }).click();
	await page.getByLabel("Name").fill("Browser fixture");
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(password);
	await page
		.getByRole("button", { name: "Create account", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Check your inbox." }),
	).toBeVisible();
	await expect(page).toHaveURL(/\/login$/);
	await page.getByRole("button", { name: "Back to sign in" }).click();
	await signIn(page, email);
	await expect(
		page.getByRole("heading", { name: "Verify your email first." }),
	).toBeVisible();
	await page.goto(await latestLink(email, "verification"));
	await expect(
		page.getByRole("heading", { name: "Your address is confirmed." }),
	).toBeVisible();
	await page.getByRole("link", { name: "Sign in", exact: true }).click();
	await signIn(page, email);
}

test("an invited researcher verifies email, recovers access and returns to a project", async ({
	page,
}) => {
	const email = address("invited");
	invite(email);
	await registerAndVerify(page, email);
	await expect(page).toHaveURL(/\/dashboard$/);
	await page
		.getByLabel("Working title", { exact: true })
		.fill("Returned after recovery");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+$/);
	const projectUrl = page.url();

	await page.getByRole("button", { name: "Browser fixture" }).click();
	await page.getByRole("menuitem", { name: "Sign Out" }).click();
	await expect(page).toHaveURL(/\/login$/);
	await page.getByRole("link", { name: "Forgot your password?" }).click();
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Send a recovery link" }).click();
	await expect(
		page.getByText("If an account uses this address", { exact: false }),
	).toBeVisible();
	await page.goto(await latestLink(email, "password-reset"));
	await page.getByLabel("New password", { exact: true }).fill(`${password}-2`);
	await page.getByLabel("Confirm new password").fill(`${password}-2`);
	await page.getByRole("button", { name: "Save new password" }).click();
	await expect(page).toHaveURL(/\/login\?reset=done$/);
	await signIn(page, email, `${password}-2`);
	await expect(page).toHaveURL(/\/dashboard$/);
	await page.goto(projectUrl);
	await expect(page.getByLabel("Working title", { exact: true })).toHaveValue(
		"Returned after recovery",
	);
});

test("a verified account without an invitation sees the pending state on every research page", async ({
	page,
}) => {
	await registerAndVerify(page, address("uninvited"));
	await expect(
		page.getByRole("heading", {
			name: "Your account is waiting for an invitation.",
		}),
	).toBeVisible();
	await page.goto("/projects/00000000-0000-4000-8000-000000000000");
	await expect(
		page.getByRole("heading", {
			name: "Your account is waiting for an invitation.",
		}),
	).toBeVisible();
});

test("expired links lead to requests for new verification and recovery links", async ({
	page,
}) => {
	await page.goto("/email-verified?error=TOKEN_EXPIRED");
	await expect(
		page.getByRole("heading", { name: "This link has expired." }),
	).toBeVisible();
	await page.getByLabel("Email").fill(address("expired"));
	await page
		.getByRole("button", { name: "Send a new verification link" })
		.click();
	await expect(
		page.getByText("If this address still needs verification", {
			exact: false,
		}),
	).toBeVisible();
	await page.goto("/reset-password?error=INVALID_TOKEN");
	await expect(
		page.getByRole("heading", { name: "This recovery link cannot be used." }),
	).toBeVisible();
});
