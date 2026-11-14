/**
 * The app's half of `window.bevel.tools`, bundled for a browser page by
 * `html-page-upload.browser.ts`: the renderer's own parsing of a frame's
 * message, its own answer to it and its own client, so the page's
 * `uploadFile` is answered by the code the file page runs and not by a
 * stand-in for it.
 */
import {
  PageConsent,
  PageToolsClient,
  answerToolCall,
  asToolCall,
} from '../../src/modules/workspace/components/renderers/htmlToolBridge';

declare global {
  interface Window {
    PageToolsHost: {
      PageConsent: typeof PageConsent;
      PageToolsClient: typeof PageToolsClient;
      answerToolCall: typeof answerToolCall;
      asToolCall: typeof asToolCall;
    };
  }
}

window.PageToolsHost = { PageConsent, PageToolsClient, answerToolCall, asToolCall };
