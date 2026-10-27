import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  { ignores: ["build/**", "desktop/**", "node_modules/**", "daemon/ui/*.js"] },
  js.configs.recommended,
  {
    files: ["daemon/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./daemon/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        URL: "readonly",
        AbortController: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript + Node supply these globals and catch unresolved symbols in
      // `bun run type-check`; ESLint's JS-only no-undef rule cannot model them.
      "no-undef": "off",
      // Existing daemon code intentionally carries compatibility helpers and
      // fixture constants. Keep lint focused on unsafe constructs while the
      // compiler remains the authoritative unused-symbol gate.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off"
    }
  },
  {
    files: ["daemon/**/*.smoke.ts"],
    linterOptions: { reportUnusedDisableDirectives: "off" }
  }
];
