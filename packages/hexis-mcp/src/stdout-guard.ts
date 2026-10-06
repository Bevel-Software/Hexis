/**
 * stdout is the protocol channel of a stdio MCP server: every byte written to
 * it is read by the client as JSON-RPC. Not every line written to it is ours.
 * A dependency that logs with `console.log` — the MCP client library did,
 * "[McpCommunicationProtocol] …" on every connection — lands on that stream.
 * The client drops a line it cannot parse, and a log line glued to an answer
 * takes the answer with it: in one session the tools never arrived, because
 * the reply to `tools/list` was lost exactly so.
 *
 * So every console method that would write to stdout is pointed at stderr,
 * where MCP clients collect server logs. This module is imported FIRST by the
 * entry point: ES module imports run in order, so the redirect is in place
 * before any later import's module body, and before `main()` runs.
 */
console.log = console.error;
console.info = console.error;
console.debug = console.error;

export {};
