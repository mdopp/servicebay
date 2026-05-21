/**
 * Webpack loader that swaps any matched file for an empty module.
 * Used by `.storybook/main.ts` to keep `packages/backend/src/lib/**`
 * out of the browser bundle, including the relative imports between
 * those files (`./dirs`, `./config`, …) that NormalModuleReplacement-
 * Plugin can't catch — that plugin matches the import *spec*, not
 * the resolved absolute path.
 */
module.exports = function emptyLoader() {
  return 'module.exports = {};';
};
