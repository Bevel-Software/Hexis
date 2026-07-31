# @bevel-software/platform-core-backend

## 0.1.1

### Patch Changes

- Internal (loopback) tool tokens are now signed with a STABLE key — `INTERNAL_TOKEN_SECRET`, or a domain-separated key derived from `JWT_SECRET` — instead of a per-boot random secret. A sibling process sharing the deployment env (a routine CLI, a second replica) now mints tokens the server verifies, so its agents can discover tools over the loopback surface. Single-process behavior is unchanged; deployments with no `JWT_SECRET` keep the per-boot random key.
  - @bevel-software/platform-shared@0.1.1
