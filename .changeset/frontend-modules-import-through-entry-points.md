---
'@bevel-software/platform-core-frontend': patch
---

Core-frontend modules reach each other only through their entry points: every module another one imports from has an `index.ts` naming what it offers, and the shell (`core/`) and package entry import modules through those indexes too. The frontend's module-boundary exception list is empty, and the lint now also covers core-frontend files outside `src/modules/`. Deep paths under `src/` stay importable for consumers (`./src/*` is unchanged). No runtime change.
