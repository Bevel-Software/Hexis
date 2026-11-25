---
'@bevel-software/platform-core-frontend': patch
---

The access verbs now say what they let someone do where a person picks or reads them. In Manage access, each verb in an opened picker (beside the add field, and on a grantee row) shows a muted line under it: Can read "Open and read it", Can edit "Read, change, approve changes, manage access", Can download "Read and save a copy", Owner "Can edit and download; be its contact". Under the request choices one line says what the chosen level lets someone do. The same line is the verb's accessible description there, on the request radios and on the verb summary of a row the reader cannot change (with the line as its tooltip). A row's own note ("from Sales", "restricted here") comes first in an item's description. The closed dialog looks as before.

The Library's Owner pill keeps its tooltip, and the card or plugin row that carries it is now described by its line for assistive tech; on a plugin the line adds that an owner may delete it. `MenuItem` takes an optional `description`: a muted line under the label, kept out of the item's accessible name. Who may do what is unchanged.
