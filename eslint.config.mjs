import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import unusedImports from "eslint-plugin-unused-imports";

// ---------------------------------------------------------------------------
// Custom ServiceBay rules.
//
// Two rules, both architecture-doc-derived (see docs/ARCHITECTURE_INVARIANTS.md):
//   - `sb/no-exec-template-literal` — bans `executor.exec(`…${x}…`)` in
//     favor of `executor.execArgv([...])`. Mirrors the semgrep rule for
//     IDE-time feedback; the aggregate count is enforced by
//     scripts/check-invariants.ts.
//   - `sb/api-route-needs-handler` — flags `route.ts` files that export
//     a verb handler without using `withApiHandler` from
//     `@/lib/api/handler`. Soft warning for new routes; the adoption
//     ratio floor is enforced by scripts/check-invariants.ts.
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
                  s.imported.name === "withApiHandler",
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
                    decl.init.callee.name === "withApiHandler"
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
    },
  },
  // Per-file ratchet exemptions for known debt. New violations in
  // unlisted files fail CI; clearing a file moves it off this list.
  // Aggregate count is tracked by scripts/check-invariants.ts.
  {
    files: [
      "src/lib/discovery.ts",
      "src/lib/manager.ts",
      "src/lib/updateWindow.ts",
      "src/lib/nginx/parser.ts",
      // Brackets in [name] are glob char-class; match via wildcard.
      "src/app/api/services/**/action-stream/route.ts",
    ],
    rules: {
      "sb/no-exec-template-literal": "warn",
    },
  },
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
