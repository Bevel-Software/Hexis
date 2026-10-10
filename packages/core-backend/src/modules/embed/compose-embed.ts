import type { IGitService, IWorkflowService } from '@bevel-software/platform-shared';
import type { KbContext } from '../../shared/kb-context.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { WriteValidator } from '../kb-fs/locking-filesystem.js';
import type { FileReaderRegistry } from '../workspace/file-readers/file-reader.js';
import type { CorePorts } from '../../core/core-ports.js';
import type { IAccountLinkService } from './account-link.service.js';
import type { EmbedAuthPort, EmbedWorkspacePort } from './embed.interface.js';
import { EmbedService, type EmbedConfig } from './embed.service.js';

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
 * distribution's ports reach it. A node-id reference (`/workspace/<branch>/
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
