---
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-core-backend': minor
---

An HTML page on the app's file page can put a file into the knowledge base: `window.bevel.tools.uploadFile(file, { branch, destination, mode })` takes a `File`, or a `Blob` with a `name` option, and the app runs the agent upload path for it with the viewer's session — `request_file_upload`, the bytes POSTed to the upload endpoint with the token in the `x-upload-token` header, then `apply_file_upload` — and resolves with the apply's answer. It is a writing call, so the page's first one shows the write card, and both tool calls are in the Audit log under the page. The token stays in the app. When the upload or the apply is refused, the app gives the token up through the new `DELETE /api/agent/uploads` (token in the `x-upload-token` header), which deletes the bytes sent with it at once rather than when the token expires. Where `window.bevel.tools` is `null` nothing changes.
