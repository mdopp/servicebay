import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import unusedImports from "eslint-plugin-unused-imports";

// ---------------------------------------------------------------------------
// Custom ServiceBay rules.
//
// Three rules, all architecture-doc-derived (see docs/ARCHITECTURE_INVARIANTS.md):
//   - `sb/no-exec-template-literal` — bans `executor.exec(`…${x}…`)` in
//     favor of `executor.execArgv([...])`. Mirrors the semgrep rule for
//     IDE-time feedback; the aggregate count is enforced by
//     scripts/check-invariants.ts.
//   - `sb/api-route-needs-handler` — flags `route.ts` files that export
//     a verb handler without using `withApiHandler` from
//     `@/lib/api/handler`. Soft warning for new routes; the adoption
//     ratio floor is enforced by scripts/check-invariants.ts.
//   - `sb/no-fe-backend-import` — bans frontend files (under
//     `src/components/**`, `src/hooks/**`, `src/dashboards/**`) from
//     importing `@/lib/install/**`, `@/lib/agent/**`, or
//     `@/lib/diagnose/**`. They route through `@/contracts/*` instead.
//     Phase 1 of the FE/BE separation (#753).
// ---------------------------------------------------------------------------
const servicebayPlugin = {
  rules: {
    "no-exec-template-literal": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow executor.exec with template-literal interpolation; use execArgv instead.",
        },
        schema: [],
        messages: {
          unsafe:
            "executor.exec with template-literal interpolation is shell-injection-prone. Use executor.execArgv([...]) which quotes each arg via shellQuoteAll.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              callee.property.type !== "Identifier" ||
              callee.property.name !== "exec"
            ) {
              return;
            }
            const first = node.arguments[0];
            if (
              first &&
              first.type === "TemplateLiteral" &&
              first.expressions.length > 0
            ) {
              context.report({ node, messageId: "unsafe" });
            }
          },
        };
      },
    },
    "api-route-needs-handler": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "API route handlers should use withApiHandler from @/lib/api/handler.",
        },
        schema: [],
        messages: {
          missing:
            "API route exports {{name}} without using withApiHandler from @/lib/api/handler. See docs/ARCHITECTURE_INVARIANTS.md § with-api-handler-adoption.",
        },
      },
      create(context) {
        const filename = context.filename ?? context.getFilename();
        if (!/[\\/]src[\\/]app[\\/]api[\\/].*[\\/]route\.tsx?$/.test(filename)) {
          return {};
        }
        let hasWithApiHandlerImport = false;
        const offendingExports = [];
        const VERBS = new Set([
          "GET",
          "POST",
          "PUT",
          "DELETE",
          "PATCH",
          "HEAD",
          "OPTIONS",
        ]);
        return {
          ImportDeclaration(node) {
            if (
              node.source.value === "@/lib/api/handler" &&
              node.specifiers.some(
                (s) =>
                  s.type === "ImportSpecifier" &&
                  s.imported.type === "Identifier" &&
                  // #603 — match both the static-route wrapper and the
                  // dynamic-segment variant.
                  (s.imported.name === "withApiHandler" ||
                    s.imported.name === "withApiHandlerParams"),
              )
            ) {
              hasWithApiHandlerImport = true;
            }
          },
          ExportNamedDeclaration(node) {
            if (!node.declaration) return;
            if (
              node.declaration.type === "FunctionDeclaration" &&
              node.declaration.id &&
              VERBS.has(node.declaration.id.name)
            ) {
              offendingExports.push({ node, name: node.declaration.id.name });
              return;
            }
            if (node.declaration.type === "VariableDeclaration") {
              for (const decl of node.declaration.declarations) {
                if (
                  decl.id.type === "Identifier" &&
                  VERBS.has(decl.id.name) &&
                  !(
                    decl.init &&
                    decl.init.type === "CallExpression" &&
                    decl.init.callee.type === "Identifier" &&
                    (decl.init.callee.name === "withApiHandler" ||
                      decl.init.callee.name === "withApiHandlerParams")
                  )
                ) {
                  offendingExports.push({ node, name: decl.id.name });
                }
              }
            }
          },
          "Program:exit"() {
            if (hasWithApiHandlerImport) return;
            for (const { node, name } of offendingExports) {
              context.report({ node, messageId: "missing", data: { name } });
            }
          },
        };
      },
    },
    // -----------------------------------------------------------------------
    // #2353 — UI-primitive + design-token reuse. The frontend ships a
    // hand-rolled design system (packages/frontend/src/components/ui/:
    // Button/Card/Field/DataTable/Badge/StatusDot/SectionHeading/PageScroll)
    // and semantic tokens (globals.css @theme inline, Tailwind v4). These two
    // rules fire at the decision point (editor/CI) when someone inlines what
    // should be a primitive or a token. Both are scoped to
    // packages/frontend/src and EXEMPT components/ui/ (the primitives wrap the
    // raw elements + intentionally map raw colours to tokens internally). See
    // docs/ARCHITECTURE_INVARIANTS.md § ui-primitive-and-design-token-reuse.
    //
    // ROLLOUT: introduced at "warn" (not "error"). A one-shot fix was
    // infeasible — the raw-colour rule alone fires ~3100 times across ~85
    // files, and rewriting each to a semantic token while keeping every
    // component visually identical is far past a single unit's safe blast
    // radius. warn keeps the 0-error gate green while surfacing every new + old
    // violation. RATCHET PLAN: burn the count down file-by-file (lint-sweep
    // units), then flip each rule to "error" once its class is at 0 — never
    // loosen. TODO(#2353): ratchet no-raw-color-literal → error after the
    // colour-token migration; ratchet no-raw-ui-primitive → error after the
    // <button>/<table>/<input> migration.
    "no-raw-ui-primitive": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Use @/components/ui primitives instead of raw <button>/<table>/<input>/<select>/<textarea> in the frontend.",
        },
        schema: [],
        messages: {
          raw: "Raw <{{tag}}> in a frontend surface. Use the {{primitive}} primitive from @/components/ui instead (components/ui/ is exempt). See docs/ARCHITECTURE_INVARIANTS.md § ui-primitive-and-design-token-reuse.",
        },
      },
      create(context) {
        // tag → primitive it should be replaced with.
        const PRIMITIVE = {
          button: "Button",
          table: "DataTable",
          input: "Field",
          select: "Field",
          textarea: "Field",
        };
        return {
          JSXOpeningElement(node) {
            const name = node.name;
            if (name.type !== "JSXIdentifier") return;
            // Lowercase name === intrinsic (raw DOM) element; a custom
            // component (Button, DataTable) is PascalCase and fine.
            const primitive = PRIMITIVE[name.name];
            if (!primitive) return;
            context.report({
              node,
              messageId: "raw",
              data: { tag: name.name, primitive },
            });
          },
        };
      },
    },
    "no-raw-color-literal": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Use @theme semantic tokens (text-accent, bg-surface, status ramp, …) instead of raw colour literals (hex / rgb() / hsl() / raw Tailwind numeric colour utilities like text-blue-500) in the frontend.",
        },
        schema: [],
        messages: {
          hex: "Raw colour literal `{{value}}`. Use a semantic @theme token (accent / surface / border / text / status-* / on-accent) from globals.css instead of a hard-coded hex/rgb/hsl. See docs/ARCHITECTURE_INVARIANTS.md § ui-primitive-and-design-token-reuse.",
          tailwind:
            "Raw Tailwind colour utility `{{value}}`. Use a semantic token utility (text-accent, bg-surface, text-status-ok, border-border, …) mapped in globals.css @theme instead of a numeric colour ramp. See docs/ARCHITECTURE_INVARIANTS.md § ui-primitive-and-design-token-reuse.",
        },
      },
      create(context) {
        // Raw hex (#rgb / #rrggbb / #rrggbbaa) and rgb()/hsl() function
        // literals embedded in a string.
        const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
        const RGB_HSL = /\b(?:rgba?|hsla?)\s*\(/;
        // Raw Tailwind numeric colour utility: {prefix}-{palette}-{n}, e.g.
        // text-blue-500, bg-gray-800, border-red-400, hover:ring-emerald-500/40.
        const PALETTE =
          "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
        const PREFIX =
          "text|bg|border|ring|from|to|via|divide|outline|decoration|shadow|fill|stroke|accent|caret|placeholder";
        // Allow modifiers + arbitrary opacity suffix. Word-boundary at the
        // start so `border-border` etc. don't match (palette list is explicit).
        const TAILWIND = new RegExp(
          `(?:^|[\\s"'\`:])(?:(?:${PREFIX})-(?:${PALETTE})-[0-9]{2,3})(?:/[0-9]{1,3})?\\b`,
        );
        function check(value, node) {
          if (typeof value !== "string") return;
          if (HEX.test(value)) {
            context.report({
              node,
              messageId: "hex",
              data: { value: (value.match(HEX) || [value])[0] },
            });
            return;
          }
          if (RGB_HSL.test(value)) {
            context.report({
              node,
              messageId: "hex",
              data: { value: (value.match(RGB_HSL) || [value])[0] },
            });
            return;
          }
          const tw = value.match(TAILWIND);
          if (tw) {
            context.report({
              node,
              messageId: "tailwind",
              data: { value: tw[0].trim() },
            });
          }
        }
        return {
          Literal(node) {
            if (typeof node.value === "string") check(node.value, node);
          },
          TemplateElement(node) {
            check(node.value.cooked ?? node.value.raw, node);
          },
        };
      },
    },
    "no-fe-backend-import": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Frontend files must not import from server-side modules (@/lib/install, @/lib/agent, @/lib/diagnose). Go through @/contracts/* instead.",
        },
        schema: [],
        messages: {
          forbidden:
            "Frontend files (src/components, src/hooks, src/dashboards) cannot import from {{path}}. Use @/contracts/* instead. See docs/ARCHITECTURE_INVARIANTS.md § fe-be-boundary.",
        },
      },
      create(context) {
        const filename = context.filename ?? context.getFilename();
        // Phase 3.3 (#764): the FE dirs left src/ entirely — they
        // live in packages/frontend/ now. The structural workspace
        // boundary makes a `@/lib/*` import unresolvable from the
        // frontend's tsconfig; this rule stays on as a quicker
        // editor-time signal + defense-in-depth.
        if (
          !/[\\/]packages[\\/]frontend[\\/]src[\\/](?:components|hooks|dashboards)[\\/]/.test(filename)
        ) {
          return {};
        }
        return {
          ImportDeclaration(node) {
            const source = node.source.value;
            if (typeof source !== "string") return;
            // The FE has no legitimate reason to reach into any
            // server-side module (`@/lib/**`) or to import directly
            // from `@servicebay/backend/**`. Go through
            // `@servicebay/api-client` instead.
            if (
              /^@\/lib\//.test(source) ||
              /^@servicebay\/backend(\/|$)/.test(source)
            ) {
              context.report({
                node: node.source,
                messageId: "forbidden",
                data: { path: source },
              });
            }
          },
        };
      },
    },
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next ships `settings.react.version: "detect"`, which makes
    // eslint-plugin-react@7.37.x auto-detect the React version via a code path
    // that calls the rule-context `getFilename()` method ESLint 10 removed
    // (TypeError: contextOrFilename.getFilename is not a function). No
    // eslint-plugin-react release supports ESLint 10's API yet, so we pin the
    // version explicitly — this short-circuits detectReactVersion() before it
    // can touch the removed API. Keep in sync with the `react` dependency.
    settings: { react: { version: "19.2" } },
  },
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    plugins: {
      "unused-imports": unusedImports,
      sb: servicebayPlugin,
    },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      // @typescript-eslint/no-unused-vars comes from nextTs preset without
      // varsIgnorePattern/argsIgnorePattern; unused-imports/no-unused-vars is
      // the authoritative owner with ^_ ignores, so disable the base rule.
      "@typescript-eslint/no-unused-vars": "off",
      // --- Dead-code detection (syntactic + constant-folded). Exact, near
      // zero false positives; complements knip (module-level unused
      // files/exports) and branch coverage (semantic / runtime-dead). These
      // catch code the TS compiler's allowUnreachableCode/
      // noFallthroughCasesInSwitch don't, e.g. dead arms behind a literalised
      // flag: `if (x || true)`, `const F = false; if (F) {…}`.
      "no-unreachable": "error",
      "no-unreachable-loop": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-constant-binary-expression": "error",
      "no-unused-private-class-members": "error",
      "no-fallthrough": "error",
      "sb/no-exec-template-literal": "error",
      // Hard error since the #603 burn-down — every API route verb
      // export must use withApiHandler / withApiHandlerParams. The
      // architecture-invariants script holds the file-level backstop.
      "sb/api-route-needs-handler": "error",
      // Phase 1 of the FE/BE separation (#753). The fe-backend-imports
      // baseline was dropped to 0 in the same PR that lands this rule
      // — any new violation fails CI both via the rule and via
      // scripts/check-invariants.ts.
      "sb/no-fe-backend-import": "error",
      // --- React-Compiler rule adoption (#1910 / #1921).
      // The ESLint 10 migration bumped eslint-plugin-react-hooks
      // 7.0.1 -> 7.1.1, whose expanded `recommended` preset (spread in by
      // eslint-config-next) added the React-Compiler rule suite. These 13
      // low-touch rules are adopted at "error" (#1921) — most are already
      // "error" in the preset, but incompatible-library and
      // unsupported-syntax ship as "warn" there, so pin every rule
      // explicitly to keep the gate deterministic.
      "react-hooks/static-components": "error",
      "react-hooks/use-memo": "error",
      "react-hooks/preserve-manual-memoization": "error",
      "react-hooks/incompatible-library": "error",
      "react-hooks/immutability": "error",
      "react-hooks/globals": "error",
      "react-hooks/refs": "error",
      "react-hooks/error-boundaries": "error",
      "react-hooks/purity": "error",
      "react-hooks/set-state-in-render": "error",
      "react-hooks/unsupported-syntax": "error",
      "react-hooks/config": "error",
      "react-hooks/gating": "error",
      // `set-state-in-effect` adopted (#1922): redundant useEffect+setState
      // pairs were removed (derive during render). The remaining unavoidable
      // cases — async fetch-on-mount / poll loaders and controlled
      // URL/prop→state syncs — each carry a per-line disable directive with
      // a written rationale at the call site.
      "react-hooks/set-state-in-effect": "error",
      // Maintainability thresholds (#724). Several core modules
      // currently exceed these — flagging them as warn (not error) so
      // CI doesn't break on legacy files while the rule still surfaces
      // every new violation in the editor. The architecture-invariants
      // script (scripts/check-invariants.ts) is the right place to
      // enforce a ratchet count when we want forward-only pressure.
      //
      // Thresholds chosen to match the issue body:
      //   - File:    800 lines (skipBlankLines/skipComments so doc-
      //              dense files aren't punished)
      //   - Function: 50 lines
      //   - Complexity: 15
      "max-lines": ["warn", { max: 800, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": [
        "warn",
        { max: 50, skipBlankLines: true, skipComments: true, IIFEs: false },
      ],
      "complexity": ["warn", { max: 15 }],
    },
  },
  {
    // #968 — backend lib code must route through @/lib/logger (trace-id
    // propagation, JSON line format, SQLite tail). console.* in
    // packages/backend/src/lib/** silently drops these. The Logger class
    // itself and the agent-handler's fallback paths are allowed via
    // file-level overrides below.
    files: ["packages/backend/src/lib/**/*.{ts,tsx}"],
    ignores: [
      "packages/backend/src/lib/logger.ts",
      "packages/backend/src/lib/logger-client.ts",
      "packages/backend/src/lib/agent/handler.ts",
      "**/*.test.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  {
    // #2353 — UI-primitive + design-token reuse, scoped to the frontend
    // application surfaces and EXEMPTING the primitives themselves
    // (components/ui/ wraps the raw elements + maps raw colours to tokens
    // internally). Introduced at "warn" during rollout; ratchet each rule to
    // "error" once its violation class is at 0 (see the rule comment + the
    // invariant doc). Test files are exempt so fixtures/markup snapshots don't
    // trip the colour rule.
    files: ["packages/frontend/src/**/*.{ts,tsx,js,jsx}"],
    ignores: [
      "packages/frontend/src/components/ui/**",
      "**/*.test.{ts,tsx,js,jsx}",
    ],
    rules: {
      "sb/no-raw-ui-primitive": "warn",
      "sb/no-raw-color-literal": "warn",
    },
  },
  {
    files: ["**/*.test.{ts,tsx,js,jsx}", "**/tests/**/*"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "complexity": "off",
    },
  },
  // All 5 ratchet-exempted files swept clean in #602 — the rule is now
  // fully tight ("error" everywhere). Any new executor.exec(`…${x}…`)
  // call fails CI without further config changes.
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "packages/frontend/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Project-specific build artifacts:
    "dist-server/**",
  ]),
]);

export default eslintConfig;
