import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.spec.ts", "tests/contracts/**/*.spec.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
