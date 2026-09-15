import { marketplaceGitUrl } from '../../../shared/marketplace-url';

/**
 * The address Claude has registered, which is this deployment's own: the
 * marketplace remote is served from it. Named rather than described so the
 * reader can match it against the row Claude shows them.
 */
export function deploymentHost(): string {
  try {
    return new URL(marketplaceGitUrl()).host;
  } catch {
    return 'this deployment';
  }
}

/**
 * The port Claude must register for it — the one this deployment is
 * actually reached on. The scheme's default when the address names none;
 * a deployment exposed on another port must be registered on that port,
 * or Claude's calls never arrive.
 */
export function deploymentPort(): string {
  try {
    const url = new URL(marketplaceGitUrl());
    return url.port || (url.protocol === 'http:' ? '80' : '443');
  } catch {
    return '443';
  }
}
