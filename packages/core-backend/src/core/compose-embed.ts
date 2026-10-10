import type { IGitService, IWorkflowService } from '@bevel-software/platform-shared';
import type { KbContext } from '../shared/kb-context.js';
import type { IAccessControl } from '../modules/access/access-control.interface.js';
import type { WriteValidator } from '../modules/kb-fs/locking-filesystem.js';
import type { FileReaderRegistry } from '../modules/workspace/file-readers/file-reader.js';
import type { CorePorts } from './core-ports.js';
import type { IAccountLinkService } from '../modules/embed/account-link.service.js';
import type { EmbedAuthPort, EmbedWorkspacePort } from '../modules/embed/embed.interface.js';
import { EmbedService, type EmbedConfig } from '../modules/embed/embed.service.js';

/** What the composition root hands the embed: the services it reads and writes through. */
export interface EmbedComposition {
  config: EmbedConfig;
  kb: KbContext;
  workspaceService: EmbedWorkspacePort;
  accessControl: IAccessControl;
  authService: EmbedAuthPort;
  workflowService: IWorkflowService;
  gitService: IGitService;
  accountLinks: IAccountLinkService;
  /** The SAME extension-to-reader registry `read_file` dispatches on. */
  readers: FileReaderRegistry;
  /** The SAME pre-disk gate the file editor and the agent tools run. */
  validateWrite: WriteValidator;
}

/**
 * The embed service as the composition root builds it — the one place the
 * distribution's ports reach it. Lives in `core/`, beside the composition
 * root it serves: the ports are core's contract with a distribution, and a
 * module never reaches up into core. A node-id reference (`/workspace/<branch>/
 * <id>`, the app's copy-link form) resolves only where a node graph is: the
 * distribution's, when it registers `ports.embedNodeIdResolver`; core has
 * none and refuses such a reference.
 */
export function composeEmbedService(deps: EmbedComposition, ports: Pick<CorePorts, 'embedNodeIdResolver'>): EmbedService {
  return new EmbedService(
    deps.config,
    deps.kb,
    deps.workspaceService,
    deps.accessControl,
    deps.authService,
    deps.workflowService,
    deps.gitService,
    deps.accountLinks,
    deps.readers,
    deps.validateWrite,
    ports.embedNodeIdResolver ?? null,
  );
}
