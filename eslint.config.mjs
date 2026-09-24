import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next. Recursive (`**/`) rather than root-only:
  // this repo keeps sibling Next.js checkouts under `.claude/worktrees/*` for in-progress work
  // (see AGENTS.md's own worktree convention), each with its own `.next` build output - a
  // root-only `.next/**` never matches those, so a live `next dev` running in a worktree
  // continuously regenerates thousands of lint errors against its own generated type-validator
  // file every time `pnpm lint` runs from the primary checkout.
  globalIgnores([
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
