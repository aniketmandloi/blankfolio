import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/start.ts", "./src/migrate.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	deps: {
		alwaysBundle: [/@blankfolio\/.*/],
	},
});
