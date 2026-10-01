import { addCustomConnectorShot, connectorNotAddedShot } from './claude-setup-shots';
import type { CarouselSlide } from './SetupCarousel';

/**
 * The last step of BOTH Claude setup routes, written once.
 *
 * Installing the plugin is where the tutorial used to stop, and it is not
 * where the setup stops: the plugin brings the skills, and its MCP server is
 * a connector Claude adds separately. A reader who left at "Add Hexis all"
 * had the skills and no knowledge base, with nothing on screen saying so.
 *
 * ONE definition, imported by the personal carousel and by the admin's
 * registration carousel, because the two are the same action on the same
 * screen. Two copies of this paragraph would be two chances to update only
 * one of them, and the admin's copy is the one nobody rereads.
 *
 * No deployment host in the copy, deliberately: the dialog arrives already
 * filled in, so the reader never types the address, and a slide with no
 * parameters is a slide that cannot be passed a different one by its two
 * callers.
 */
export const connectorSlide: CarouselSlide = {
  shortLabel: 'Connector',
  stage: 'Connect the knowledge base',
  title: 'Add the hexis connector',
  instruction: (
    <>
      Installing <b>Hexis all</b> does not connect its MCP server. Open the plugin's{' '}
      <b>tools and data sources</b> list and the <code>hexis</code> row reads <b>Not added</b>.
      Choose <b>Add for your team</b>: Claude opens its <b>Add custom connector</b> dialog with the
      name and URL already filled in. Choose <b>Continue</b>, then approve the sign-in on this
      deployment. It worked when the row no longer reads <b>Not added</b>. Without
      organization-admin rights in Claude you are offered the connector for yourself instead, which
      works the same for you — or ask an admin to add it for the team.
    </>
  ),
  shots: [connectorNotAddedShot, addCustomConnectorShot],
};
