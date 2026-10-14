/**
 * The real intermediary for the chat view's suite: the MCP Apps SDK's own
 * host-side bridge, bundled for a browser page by the test itself (see
 * `mcp-app-renewal.browser.ts`). The view speaks the extension's protocol
 * by hand, with no SDK, and this is how its half is held to the SDK's.
 *
 * Nothing of ours is in here on purpose: the page under test is the view as
 * core-backend ships it, and the host is the SDK as published.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

declare global {
  interface Window {
    McpHost: { AppBridge: typeof AppBridge; PostMessageTransport: typeof PostMessageTransport };
  }
}

window.McpHost = { AppBridge, PostMessageTransport };
