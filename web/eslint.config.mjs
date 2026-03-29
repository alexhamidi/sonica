import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/components/Canvas.tsx"],
    rules: {
      // Canvas syncs props into refs for rAF/pointer handlers; registerImg caches per index.
      "react-hooks/refs": "off",
    },
  },
  {
    files: ["app/components/Player.tsx"],
    rules: {
      // Audio element setup resets playing state when the active track changes.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
