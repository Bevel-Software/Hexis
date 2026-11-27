import { AuthService } from '../modules/auth/auth.service.js';

/**
 * The auth service, constructed the way the composition root constructs it
 * (`core/create-core-services.ts`). A module's suite that drives routes which
 * take the real service — the access routes, which it guards — takes it from
 * HERE rather than constructing another module's implementation itself: the
 * auth entry holds the service's contract and the class behind it is the
 * root's to wire, as `real-disk.ts` stands in for the root for the disk.
 */
export function realAuthService(...args: ConstructorParameters<typeof AuthService>): AuthService {
  return new AuthService(...args);
}
