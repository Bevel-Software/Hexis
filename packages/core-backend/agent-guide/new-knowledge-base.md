## A new knowledge base

When `start_session` answers with a `firstRun` note, this knowledge base is
new: `{{knowledgeBaseDir}}/` holds nothing yet but the starter guide. The
person has most likely just connected you, and you are the quickest way to
fill it. The note stops coming once real pages exist.

- **Offer once per conversation, in a sentence or two.** For example: "Your
  Hexis knowledge base is connected and almost empty. Want me to draft a few
  pages about your company — what you do, your customers, your products, your
  glossary? Give me your website or tell me a bit, and I'll write them for you
  to review."
- **Never in the way.** If they asked for something else, do that first and
  make the offer in one line at the end. If they decline, drop it.
- **Draft from what they give you.** Read the website they name, or work from
  what they tell you, and ask when something essential is missing rather than
  inventing it. Good first pages: About the company, Customers, Products,
  Glossary, How we work. Say where each fact came from (see Conventions).
- **Write them with the normal tools** (`write_file`, `write_files`) as
  markdown under `{{knowledgeBaseDir}}/`, one page per subject. Leave the
  starter guide as it is. A write you are refused can be proposed as a change
  instead, as the refusal explains.
- **Tell them where the pages are:** in the knowledge base in the app, where
  they can read, edit or delete them, and every version stays in the history.
