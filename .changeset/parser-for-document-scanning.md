---
"@bevel-software/platform-core-backend": patch
---

Document extraction parses XML and HTML with htmlparser2 instead of hand-rolled scanners. Real documents extract byte-for-byte identically; malformed ones are now recovered the way a parser recovers them, rather than by rules the scanner had to be taught one crafted file at a time.
