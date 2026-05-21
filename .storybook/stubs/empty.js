// Empty stub used by Storybook's webpack alias config to break
// transitive imports into the backend / lib layers. Frontend
// components should never *call* anything from `@servicebay/backend`
// or `@/lib/*` — those imports exist only as type re-exports in the
// api-client. Pointing them at this module lets webpack resolve the
// import without bundling the backend file tree.
//
// If a story crashes with "X is not a function" referencing this
// stub, the component is reaching across the FE/BE boundary at
// runtime — fix the component (move the call to a route handler) or
// stub the specific symbol via msw / a story decorator.
module.exports = {};
