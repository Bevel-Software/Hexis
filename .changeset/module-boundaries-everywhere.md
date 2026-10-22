---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Every module is reached through its public entry. The module-boundary lint shipped with an exception list of 224 files that still imported another module's internals; that list is empty now. Each backend module's `index.ts` carries what the others read of it — its contracts and types, the leaf helpers and constants — and the five modules that had no entry (`database`, `diff`, `mcp`, `tool-auth`, `write-access`) have one. Services another module needs are imported as types, so an index never loads a module's implementations. The core frontend's modules get entries for their hooks, services, contexts, utilities and types (`access`, `admin`, `auth`, `change-requests`, `layout`, `onboarding`, `settings`, `setup`, `toolbar` are new); a React component, and a module's stylesheet, is composed into another module's screen by importing its file, which the lint now allows on purpose — an index that re-exported components would load every screen behind any hook imported from it. No runtime behaviour changes.
