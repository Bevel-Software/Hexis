---
"@bevel-software/platform-core-frontend": patch
---

The pptx outline and the email viewer read XML and HTML with htmlparser2 instead of hand-rolled scanners, matching the backend extractors so the viewer and `read_file` cannot drift apart. `renderers/xmlEntities.ts` is now `renderers/xmlReading.ts`.
