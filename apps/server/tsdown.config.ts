import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/start.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	deps: {
		// Vercel serves dist/ from the function root, away from the traced
		// apps/server/node_modules, so the build must not import packages at runtime.
		alwaysBundle: [/.*/],
	},
});
