import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // The real `obsidian` module only exists inside the app.
      obsidian: path.resolve(import.meta.dirname, "tests/mocks/obsidian.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
