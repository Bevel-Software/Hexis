import { ClaudeConnectionCard } from '../../settings/components/ClaudeConnectionCard';
import { SetupCarousel, type CarouselSlide } from './SetupCarousel';
import { connectorSlide } from './claude-connector-slide';
import { Out, Prose } from './setup-step-parts';
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

function slides(host: string, opened: boolean): CarouselSlide[] {
  return [
    {
      shortLabel: 'Add manually',
      stage: 'Register the instance',
      title: 'Register this deployment with your Claude organization',
      instruction: (
        <>
          An Owner of your Claude organization does this once, on a Team or Enterprise plan. Open{' '}
          <Out href={CLAUDE_CODE_ADMIN}>Admin settings → Claude Code</Out>, scroll to Self-hosted
          infrastructure, and choose <b>Add manually</b> beside GitHub Enterprise.
        </>
      ),
      shots: [addManuallyShot],
    },
    {
      shortLabel: 'Configure',
      stage: 'Register the instance',
      title: 'Fill the form and add the configuration',
      instruction: (
        <>
          Fill it from the fields below, which this deployment generated for exactly this form. Any
          display name will do, the port is {deploymentPort()}, and read replicas stay empty. Choose{' '}
          <b>Add configuration</b>. The webhook URL Claude shows afterwards can be ignored: nothing
          here sends webhooks yet, and the private key is required by the form but unused by this
          flow.
        </>
      ),
      // Two gates, both required: the drawer is open, and this is the slide
      // that asks for them. A closed <details> still mounts its children, so
      // the first keeps a client secret out of a drawer nobody looked at;
      // the carousel mounts only the active slide, so the second keeps it
      // off the four slides that have no use for it.
      extra: opened ? <ClaudeConnectionCard /> : null,
      shots: [addConfigurationShot],
    },
    {
      shortLabel: 'Connect',
      stage: 'Connect your account',
      title: 'Connect your own Claude account to it',
      instruction: (
        <>
          Registering the instance signs nobody in, and Claude never prompts for this. Open{' '}
          <Out href={GITHUB_ADMIN}>Admin settings → GitHub</Out> and choose <b>Connect</b>.
        </>
      ),
      shots: [connectAccountShot],
    },
    {
      shortLabel: 'Instance',
      stage: 'Connect your account',
      title: 'Pick this deployment as the GitHub instance',
      instruction: (
        <>
          Under GitHub instance, pick {host} instead of github.com, then continue. You land on the
          sign-in here: approve, and you are back in Claude. Everyone else does the same from the
          repository picker on <Out href={CLAUDE_CODE_WEB}>claude.ai/code</Out>, which offers the
          same instance.
        </>
      ),
      shots: [pickInstanceShot],
    },
    connectorSlide,
  ];
}

/**
 * Registering this deployment with a Claude organization as a GitHub
 * Enterprise Server: the admin's half of the Cowork route, which used to be
 * the admin branch of the External agent access tutorial and now lives in
 * the Marketplace section of Deployment configuration.
 *
 * A carousel on the same shell as the personal tutorial, rather than the
 * ordered list this used to be: four full-size screenshots down a page is a
 * wall, and the admin reading it is following one screen at a time anyway.
 * The last slide is the shared connector step, the same one everybody else
 * ends on.
 *
 * `opened` gates the credentials. A closed <details> still mounts its
 * children, so without it every admin who scrolled past the section fetched
 * a client secret and a private key into a drawer they never looked at.
 * Secrets load when someone is reading the step that asks for them, not
 * before — and now only while that step is the slide on screen.
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
        Server your Claude organization has registered. This deployment answers as one. The four
        registration steps are yours. Adding the marketplace is what every person here does next,
        from External agent access — the connector at the end is on both lists, because it is the
        same action.
      </Prose>

      {/* Not the drawer's own words. The <summary> above already reads
          "Register this deployment with Claude", and a region nested inside
          the control that carries that name would announce it twice. */}
      <SetupCarousel label="Claude registration steps" slides={slides(host, opened)} />
    </div>
  );
}
