---
'@bevel-software/platform-core-frontend': patch
---

A change request that adds or changes a pdf, docx, pptx, xlsx, image or email now shows the PROPOSED file in the change-request dialog, rendered by the same viewer the file page uses and read from the request's branch — instead of the sentence "there is no text to compare". A changed file is labelled "Proposed version" and offers "Open the current version" on the target branch; a binary the request does not touch shows its current version; formats no viewer renders (`.doc`, `.ppt`, `.xls`, OpenDocument, `.zip`) keep the note and gain "Download the proposed file". Reading the bytes goes through the same access check as the file page, and a reader without access gets the same refusal.
