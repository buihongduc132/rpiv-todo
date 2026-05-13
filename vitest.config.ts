import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			thresholds: {
				lines: 70,
				branches: 65,
				functions: 55,
				statements: 70,
			},
			include: ["todo.ts"],
			exclude: ["todo-overlay.ts", "index.ts"],
		},
	},
});
