---
'@bevel-software/platform-core-backend': patch
---

Logging a timeout or an abort no longer fails the call that logged it. The escaped copy `oneLineError` returns now holds, as its own values, every accessor its prototype defines, read once on the original. A `DOMException`'s `code` and any getter that checks its receiver can then be read and listed on the copy. Before, pino's error serializer threw `Value of "this" must be of DOMException` out of the `catch` that was logging. Each logger is also behind a new `neverThrowing` guard: the console sink, the module handle `logger()` for whatever sink is installed, and any sink a shell wraps in it. If a record cannot be made or written, the guard writes a plain record that says why, and the call returns.
