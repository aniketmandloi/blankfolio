import { defineConfig } from "@playwright/test";
/** Intentionally no webServer: repository rules require explicit server permission. */
export default defineConfig({
	testDir: "./tests",
	use: {
		baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001",
		storageState:
			process.env.PLAYWRIGHT_STORAGE_STATE ?? ".auth/researcher.json",
	},
	projects: [
		{ name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
		{ name: "small-screen", use: { viewport: { width: 360, height: 800 } } },
	],
});
