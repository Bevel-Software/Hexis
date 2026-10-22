---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Module boundaries are linted: code in one `src/modules/<name>/` folder that imports another module's internals, rather than its `index.ts`, now fails ESLint, in core-backend and core-frontend alike. 98 imports that the target's index already served now go through it; the files not yet held to the rule are listed, each with its reason, in `eslint.module-boundaries.js`. No runtime change.
