import { ClaudeConnectionCard } from '../../settings/components/ClaudeConnectionCard';
import { ScreenshotStep } from './ScreenshotStep';
import { Out, Prose, Step } from './setup-step-parts';
import { deploymentHost, deploymentPort } from './deployment-address';
import {
  addConfigurationShot,
  addManuallyShot,
  connectAccountShot,
  pickInstanceShot,
} from './claude-setup-shots';

/** Where an Owner registers a GitHub Enterprise Server with the organization. */
const CLAUDE_CODE_ADMIN = 'https://claude.ai/admin-settings/claude-code';
/** Where an Owner connects their own account to a registered instance. */
const GITHUB_ADMIN = 'https://claude.ai/admin-settings/github';
/** The repository picker, which offers the same connection to everyone else. */
const CLAUDE_CODE_WEB = 'https://claude.ai/code';

/**
 * Registering this deployment with a Claude organization as a GitHub
 * Enterprise Server: the admin's half of the Cowork route, which used to be
 * the admin branch of the External agent access tutorial and now lives in
 * the Marketplace section of Deployment configuration.
 *
 * `opened` gates the credentials. A closed <details> still mounts its
 * children, so without it every admin who scrolled past the section fetched
 * a client secret and a private key into a drawer they never looked at.
 * Secrets load when someone is reading the step that asks for them, not
 * before.
 *
 * Admin HERE is not the same authority as Owner of the Claude organization:
 * the copy names the Claude side explicitly so an admin without it knows who
 * to hand step 1 to.
 */
export function ClaudeRegistrationSteps({ opened }: { opened: boolean }) {
  const host = deploymentHost();

  return (
    <div className="space-y-3">
      <Prose>
        Cowork and claude.ai install marketplaces only from GitHub, or from a GitHub Enterprise
        Server your Claude organization has registered. This deployment answers as one. Steps 1 and
        2 are yours. Everything after is what every person here does, from External agent access.
      </Prose>

      <ol className="list-decimal space-y-4 pl-4 marker:text-ink-faint marker:text-meta">
        <Step title="Register this deployment with your Claude organization">
          <Prose>
            An Owner of your Claude organization does this once, on a Team or Enterprise
            plan. Open{' '}
            <Out href={CLAUDE_CODE_ADMIN}>Admin settings → Claude Code</Out>, scroll to
            Self-hosted infrastructure, and choose <b>Add manually</b> beside GitHub
            Enterprise.
          </Prose>
          <ScreenshotStep shot={addManuallyShot} />
          <Prose>
            Fill it from the fields below, which this deployment generated for exactly this
            form. Any display name will do, the port is {deploymentPort()}, and read replicas
            stay empty.
            Choose <b>Add configuration</b>. The webhook URL Claude shows afterwards can be
            ignored: nothing here sends webhooks yet, and the private key is required by the
            form but unused by this flow.
          </Prose>
          {opened && <ClaudeConnectionCard />}
          <ScreenshotStep shot={addConfigurationShot} />
        </Step>

        <Step title="Connect your own Claude account to it">
          <Prose>
            Registering the instance signs nobody in, and Claude never prompts for this. Open{' '}
            <Out href={GITHUB_ADMIN}>Admin settings → GitHub</Out> and choose <b>Connect</b>.
          </Prose>
          <ScreenshotStep shot={connectAccountShot} />
          <Prose>
            Under GitHub instance, pick {host} instead of github.com, then continue. You land
            on the sign-in here: approve, and you are back in Claude.
          </Prose>
          <ScreenshotStep shot={pickInstanceShot} />
          <Prose>
            Everyone else does the same from the repository picker on{' '}
            <Out href={CLAUDE_CODE_WEB}>claude.ai/code</Out>, which offers the same instance.
          </Prose>
        </Step>
      </ol>
    </div>
  );
}
