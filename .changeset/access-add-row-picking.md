---
'@bevel-software/platform-core-frontend': patch
---

Sharing with several people or groups at once in the Manage access sheet no longer needs a click back into the field after every pick, and the list stops offering what is already picked.

Picking a suggestion moved focus onto the list, which then closed, so the next name could not be typed until the field was clicked again; the caret now returns to the field on every pick. The suggestion list also showed principals already sitting in the field as chips, which read as though the pick had not taken; it now offers only what is not yet picked, and offers a principal again as soon as its chip is removed.
