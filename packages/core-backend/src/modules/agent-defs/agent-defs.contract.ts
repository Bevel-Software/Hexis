/**
 * `.agent` files — the identity an execution layer runs a pipeline step as.
 *
 * The platform is NOT the interpreter of these files. The Agentic Execution
 * Layer reads the whole thing (harness, model, skills, plugins, allowed tools,
 * system prompt) and runs the session; the platform reads only the one part it
 * has to arbitrate — which vault secrets the file is allowed to have injected —
 * plus enough identity to name the file in a list. Two readers, two questions,
 * deliberately not one shared parser: the platform's copy must stay a narrow
 * allowlist reader that cannot be widened by a field it doesn't understand.
 *
 * Everything here is derived by re-reading the file from the DEFAULT branch, so
 * the knowledge base IS the allowlist. A caller asking to resolve secrets never
 * names the variables it wants — it names the file, and the file decides.
 */

/** Where one `env:` entry's value comes from. */
export type AgentEnvSource = 'params' | 'vault';

/** One declared runtime-environment variable of an `.agent`. */
export interface AgentEnvVariable {
  /** The environment variable name as the session process will see it. */
  name: string;
  from: AgentEnvSource;
  /** Human label for the secrets UI (vault entries only). */
  label?: string;
}

/** An `.agent` as the platform sees it — identity plus its declared environment. */
export interface AgentDefinitionSummary {
  /** URL-safe id, unique across the knowledge base (equal to `name`). */
  slug: string;
  /** The agent's declared name — also the vault namespace its secrets bind to. */
  name: string;
  /** Repo-relative path, e.g. `Agents/delivery-coder.agent`. */
  path: string;
  description?: string;
  /** Declared `env:` entries resolved `from: vault` — the entire secret allowlist. */
  vaultVariables: AgentEnvVariable[];
}

export interface IAgentDefinitionService {
  /** Every `.agent` in the knowledge base, ignoring the caller's access. */
  listAll(): Promise<AgentDefinitionSummary[]>;
  /** The `.agent` files this caller may read. */
  listAccessible(userEmail: string): Promise<AgentDefinitionSummary[]>;
  /** One accessible `.agent` by slug, or null. */
  getAccessible(userEmail: string, slug: string): Promise<AgentDefinitionSummary | null>;
  /** Drop the cached scan (after a merge to the default branch). */
  invalidate(): void;
}
