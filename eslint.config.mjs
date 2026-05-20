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
        // Phase 3.2 (#763) moved the FE dirs into packages/frontend/.
        // Match both the old location (transitional — drops to zero
        // matches once Phase 3.3 cleans up) and the new package path.
        if (
          !/[\\/]src[\\/](components|hooks|dashboards)[\\/]/.test(filename) &&
          !/[\\/]packages[\\/]frontend[\\/]src[\\/]/.test(filename)
        ) {
          return {};
        }
        return {
          ImportDeclaration(node) {
            const source = node.source.value;
            if (typeof source !== "string") return;
            // Phase 3.2: broaden from the original install/agent/diagnose
            // trio to ALL of @/lib/* (the FE has no legitimate reason to
            // reach into any server-side module).
            if (
              /^@\/lib\//.test(source)
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
      "sb/no-exec-template-literal": "error",
      // Soft warning — the architecture-invariants script enforces the
      // adoption ratio. This rule nudges new authors in their editor.
      "sb/api-route-needs-handler": "warn",
      // Phase 1 of the FE/BE separation (#753). The fe-backend-imports
      // baseline was dropped to 0 in the same PR that lands this rule
      // — any new violation fails CI both via the rule and via
      // scripts/check-invariants.ts.
      "sb/no-fe-backend-import": "error",
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
  // All 5 ratchet-exempted files swept clean in #602 — the rule is now
  // fully tight ("error" everywhere). Any new executor.exec(`…${x}…`)
  // call fails CI without further config changes.
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Project-specific build artifacts:
    "dist-server/**",
  ]),
]);

export default eslintConfig;
