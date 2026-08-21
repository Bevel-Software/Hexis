---
"@bevel-software/platform-core-backend": minor
"@bevel-software/platform-mcp-core": minor
"@bevel-software/hexis-mcp": minor
---

`read_file` on an image returns the image itself as native MCP image content. A `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp` read comes back as an MCP image content block (base64 + mimeType) plus a one-line text note naming the path, size and dimensions — so a multimodal client actually sees the picture instead of a binary-file notice. `.svg` stays on the text path. Images over 3.5 MB raw are refused with an honest message (base64 inflation would push them past what Claude-family clients accept — downscale locally or upload a smaller export). The local `hexis-mcp` server forwards the image blocks unmangled, and `call_tool_chain` deliberately omits image payloads from chain results (a chained image read yields an `{ image_omitted, note }` stub — images are only delivered on a direct `read_file` call).
