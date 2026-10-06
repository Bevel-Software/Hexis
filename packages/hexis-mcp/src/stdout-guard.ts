import { Console } from 'node:console';

/**
 * stdout is the protocol channel of a stdio MCP server: every byte written to
 * it is read by the client as JSON-RPC. Not every line written to it is ours.
 * A dependency that logs with `console.log` — the MCP client library did,
 * "[McpCommunicationProtocol] …" on every connection — lands on that stream.
 * The client drops a line it cannot parse, and a log line glued to an answer
 * takes the answer with it: in one session the tools never arrived, because
 * the reply to `tools/list` was lost exactly so.
 *
 * So the global console is replaced by one whose BOTH streams are stderr,
 * where MCP clients collect server logs. One instance, not a list of
 * methods: `log`, `info`, `debug`, `dir`, `table`, `count`, `timeEnd`,
 * `group` and whatever Node adds next all write where that instance's
 * stdout points, with their formatting, counters and timers intact.
 *
 * This module is imported FIRST by the entry point: ES module imports run
 * in order, so the replacement is in place before any later import's module
 * body, and before `main()` runs.
 */
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

export {};
