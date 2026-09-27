import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/start.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	deps: {
		alwaysBundle: [/@blankfolio\/.*/],
	},
});
