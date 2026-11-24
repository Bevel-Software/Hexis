---
'@bevel-software/platform-core-backend': minor
---

A `.tool` can send a file as one part of a form. Until now a tool sent a file only as the whole request body, so an API that takes the file beside other fields (`multipart/form-data`) could not be given a file from chat or the knowledge base. A tool whose call says `content_type: multipart/form-data` and whose body is an object with a `format: file-path` property now goes out as a form: that property is the file, under its own name and content type, text values go as written, and any other value as JSON. A property the call leaves out or sets to `null` is not sent; a file property that is there but names no file refuses the call. The file is read as the person, and one they cannot read refuses the call before anything is sent.
