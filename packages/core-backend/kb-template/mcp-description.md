<!-- Remove this comment wrapper (the first and last lines of this file) to broadcast the text below to every connected agent.

This file is the deployment preamble. Every agent that connects to this knowledge base over MCP, hosted or through the local hexis-mcp server, is told its content at the start of each session, whatever that agent's access. It arrives after a fixed platform header that already says what Hexis is and to search here before answering from memory; this file adds what only you know: what this knowledge base holds, where things are, and when an agent must look here first.

Keep the content under 6,000 characters. Keep the first paragraph under 300 characters: it is also shown at the start of the start_session, grep, list_files and read_file tool descriptions, which is all some clients (claude.ai on the web, Cline, the Agent SDK) show the model. Text inside an HTML comment like this one is never sent, so notes to yourself can stay here. Folder names you write are sent to every agent, including those that cannot open the folders.

Starter skeleton, fill in and delete what does not apply:

Acme is a solar developer in Spain. This knowledge base holds our project files, permitting process, customer records and engineering conventions.

## What is where

- {{knowledgeBaseDir}}/Projects/: one folder per site, with its permits, contracts and status.
- {{knowledgeBaseDir}}/Processes/: how we run permitting, procurement and commissioning.
- {{knowledgeBaseDir}}/Customers/: accounts, contacts and meeting notes.

## Always check here before answering about

- Any project, customer or supplier by name.
- Our permitting steps, timelines and the authorities involved.
- Internal terms, acronyms and team responsibilities.

## Conventions

- Dates are written YYYY-MM-DD. Money is in EUR unless stated.
- Cite the file you read when you answer from it.
-->
