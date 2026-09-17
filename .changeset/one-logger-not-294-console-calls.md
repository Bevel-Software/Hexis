---
'@bevel-software/platform-core-backend': patch
---

The backend logs through one port. Every one of its 294 bare `console.*` calls is gone; each module asks for a tagged logger and writes a message with optional structured fields, and the process decides once where lines go and what shape they take.

For anyone reading a terminal nothing changes: the default sink, which needs no dependency, writes exactly what the backend always wrote — `[module] message`, the fields after it, an error with its stack — so a log line looks as it did and the suites that watch the console still see what they assert on. What changes is that a deployment can now install a real logger. The standalone server shell installs pino, so a running deployment emits one JSON object per line with a level, a time, the module the line came from and whatever fields the call carried, which is what a log pipeline filters and groups by. Errors serialize as errors rather than as empty objects, and writes go through pino's own stream rather than a blocking write to stdout, so a full pipe — which is what stdout is under Docker's json-file driver — cannot stall the event loop.

The library lives in the server shell, not in the published package. The package owns the contract and the dependency-free default; a distribution's own shell installs whatever it runs on, through the exported `setLogger`; and npm consumers inherit no logging stack. The enterprise overlay can hand in its own logger instead of running two side by side.

A lint rule now forbids direct `console` use in the backend's source, so the fact that everything goes through the port is checked rather than trusted. `LOG_LEVEL` sets pino's level in the shell; the default is `info`.
