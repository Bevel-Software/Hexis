# Pipelines/

`.pipeline` files — the **processes the agentic execution layer runs**, in the
spirit of a CI workflow file: declarative definitions the executor interprets.
The executor itself encodes no process behavior; everything a run does is
defined here.

## Structure

```text
Pipelines/
└── <process-name>.pipeline    ← one file per process
```

(Exact file format: TBD.)

## What a `.pipeline` defines

A sequence of **nodes**, each one of:

- an **`.agent` reference** — an agent session executes the step;
- a **UTCP tool call** — a tool from `Tools/` (or defined in-file), invoked
  deterministically with no LLM;
- a **wait node** — parks the run until a condition holds; checked cheaply
  every tick, never by an agent polling.

Plus, per pipeline:

- **Transitions** — where each outcome routes;
- **Failure policy** — attempt caps and loop-back targets;
- **Triggers** — what starts a run: cron, a `Data/` node reaching a status,
  a webhook, or a human assigning a work item;
- Human approvals ride **change requests** — "park until approved" is a
  native gate.

Pipelines may call other pipelines. Every triggered run gets a durable
**instance node under `Data/`** carrying its state, so executors stay
stateless and any step can be retried.
