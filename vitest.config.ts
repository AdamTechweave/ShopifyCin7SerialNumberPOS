import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.ts", "extensions/**/src/**/*.test.{ts,js}"],
    environment: "node",
    passWithNoTests: true,
  },
});
