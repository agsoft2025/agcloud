// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // This codebase deliberately types a lot of Mongo/JWT/Fastify boundary
      // data as `any` (see jwt.ts, error-handler.ts, rate-limit.middleware.ts) —
      // tightening this is a larger typing effort, not a lint-config decision.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The app has one structured logging pipeline (shared pino instance,
      // see src/shared/observability/logger.ts) — raw console output bypasses
      // log levels, JSON structure, and request/trace correlation, so it's
      // disallowed everywhere except the narrow, documented exception in
      // tracing.ts (see its file-level eslint-disable).
      "no-console": "warn",
    },
  },
  prettierConfig
);
