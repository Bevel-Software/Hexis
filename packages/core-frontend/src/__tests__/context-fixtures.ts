/**
 * The context values a suite needs when it renders a surface that reads other
 * modules' contexts, gathered at the root like the shell that composes them.
 * A suite outside the workspace or auth module takes them from here rather
 * than from those modules' own test folders; the modules' suites keep their
 * fixtures where they are, and this is one name for each, not a second copy.
 */
export { makeWorkspaceFixture } from '../modules/workspace/__tests__/testFixtures';
export { authValue } from '../modules/library/__tests__/auth-harness';
