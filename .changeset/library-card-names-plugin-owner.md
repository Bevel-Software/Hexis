---
'@bevel-software/platform-core-frontend': patch
---

A plugin's row in the Library names its owner in "Run by …". The plugin listing names people by email, with no display name, and the helper that builds the line left such a person out of the owners and the writers it reads, so a plugin owned by one person, whose other writer is the Admin role it inherits, read "Run by Admin". A person without a display name now reads as their email, so that row reads "Run by" and the owner's email, beside any owning group; a plugin with no owner, whose only writer is the inherited Admin role, still reads "Run by Admin". The locked plugin page's "Run by" and "Requested" lines and both Subscribe confirmations (from the row and from the locked page) name such a person by email too, and a skill page names its reviewer with the same helper. Who owns or may change a plugin is unchanged.
