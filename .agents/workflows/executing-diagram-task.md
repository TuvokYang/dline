---
name: executing-diagram-task
description: Execute one approved Workstream task by turning its verified diagram into a node-and-edge execution ledger, implementing in graph topological order, proving every node and edge exists on both sides, and returning to the diagram when code reveals a structural fact.
---

# Executing a Diagram Task

This workflow covers **implementation only**. The task's architecture is already designed, verified and confirmed when this workflow starts.

| Concern | Owner |
| --- | --- |
| what the task should be | `designing-workstream-diagrams` |
| whether the diagram holds | `verify-architecture-diagrams` |
| the task's full lifecycle including confirmation | `diagram-driven-task` |
| **how to turn the diagram into code** | this workflow |

Load this workflow from step 7 of `diagram-driven-task`, never as a substitute for it.

## Preconditions

All four must hold. If any fails, return to `diagram-driven-task` instead of implementing.

1. The task diagram exists in the task's `plan.md` and is annotated with `%% id:`, `%% layer:`, `%% kind:` and `%% refines:`.
2. `--scope task:<TASK-ID>` was run and its exit code is recorded. Exit `0` proceeds. Exit `1` proceeds only when every blocking or unverifiable finding is either Workstream-attributed and already routed to the Workstream, or accepted by the user as postponed. Exit `2` stops: the tool is unsound.
3. Any required Workstream diagram change is confirmed.
4. `progress.md` has no unresolved `blockers`. A non-empty `waiting_for` fences only the regions it names; the ledger rows that touch those regions wait, the rest proceed.

## 1. Freeze the execution baseline

Record into the task's `plan.md` before writing code, by reference rather than by copy:

- the diagram's `%% id:` and the spec file's current git blob (`git rev-parse HEAD:<path>` or the content hash when uncommitted); the diagram itself stays in its one place;
- the task's `owns` boundaries from `goals.yaml` by id, not restated;
- the `required_verification` ids;
- which upstream tasks already landed, and what they exported.

Freeze means later steps compare against this reference. A diagram edited mid-execution changes the recorded hash, invalidates the ledger and forces a re-verify. Copying the diagram or the contracts into the plan creates a second fact source that drifts; the memory rules forbid it.

## 2. Build the execution ledger

The ledger is the bridge from diagram to code. Write it into `plan.md` as two tables. Do not start coding before both exist. Keep each table to the columns below; a ledger that restates the diagram is the write amplification §1 forbids.

### Node ledger

| Column | Meaning |
| --- | --- |
| Node | diagram node id |
| Artifact | the file or symbol that realizes it |
| Writer | the one module allowed to mutate its canonical state |
| State | `exists` / `partial` / `new` |
| Owning section | the exact code region to create or change |

Rules:

- Every node in the diagram gets one row. A node without an artifact is not implementable and means the diagram is too abstract.
- `Writer` is mandatory for a node holding canonical state. Two rows naming different writers for one canonical fact is a split authority: stop and fix the diagram.
- `State: exists` requires a path and symbol you have actually read, not a guess from the name.

### Edge ledger

| Column | Meaning |
| --- | --- |
| Edge | `A --> B` or `A -.-> B` with its label |
| Style | `solid` command/data, or `dotted` fact/constraint |
| Emit side | where the source produces it: function, method, or event |
| Receive side | where the target consumes it: parameter, port, or handler |
| Proof | the observable evidence that both sides are wired |

Rules:

- **An edge is implemented only when both sides exist.** A call with no receiver, a published event with no consumer, or a declared port nobody calls is a half edge. Half edges are the most common false "done"; they compile and do nothing.
- `Emit side` and `Receive side` must be different locations. If they are the same line, you have not implemented a relation, you have annotated one.
- A solid edge must name a concrete interface crossing. "A knows about B" is not an edge implementation.
- A dotted edge must name the condition under which the fact appears and the place that observes it. A fact nobody reads is dead wiring.

## 3. Order the work

Implement in the diagram's topological order, then respect write boundaries.

1. Order nodes by the topological order of solid edges: producers before consumers.
2. Within one node, implement its writer path before its projection or reporting paths.
3. Group nodes whose artifacts live in the same file region, and implement them together to avoid repeated partial rewrites.
4. Dotted edges never determine order. They are the checks you run after the solid graph works; a fact cannot be observed before its producer exists.

Two ordering rules matter more than speed:

- **Never implement a consumer before its producer to make a test pass.** A stub producer is a fake adapter in disguise.
- **Never implement an edge by reaching across a boundary the diagram does not draw.** If A needs B and no edge exists, the diagram is incomplete: return to the diagram, do not add the import.

## 4. Execute one node

For each node in order:

1. Confirm the artifact's current state matches the ledger. If it changed, re-read and update the ledger before editing.
2. Create or change only the region the ledger names.
3. Add the exported symbol the diagram implies, at the boundary that owns it. Do not add a forwarding layer the diagram does not show.
4. Re-read what you wrote before moving on. Verify the symbol exists where a consumer can import it.

Do not create compatibility shims, aliases, or re-exports for symbols the diagram does not declare. The project's existing patterns decide style; the diagram decides structure.

## 5. Execute one edge

For each edge in solid-graph order:

1. Wire the emit side first.
2. Wire the receive side next, in the same batch. Leave `Receive side` empty only if the target node is also in this batch and its write region comes next.
3. Record the proof: a call site, a passed port, a delivered command, or a focused test that fails when either side is removed.
4. Fill `Emit side`, `Receive side` and `Proof` in the ledger.

For a dotted edge, implement the fact's production and observation, then confirm the observation exists at a place the diagram names. `%% note:`-style observations are not evidence.

## 6. Reconcile drift immediately

During implementation, code sometimes reveals a structural fact the diagram does not capture. That is expected. The response is fixed:

| What you found | Response |
| --- | --- |
| the diagram omits an edge or node | stop, return to `designing-workstream-diagrams`, re-verify, then re-confirm |
| an edge cannot exist as drawn | stop, the diagram's direction is wrong |
| a node needs a second writer | stop, the Workstream authority model is wrong |
| the artifact already exists and is wired | record `State: exists`, do not rewrite it |
| the Ledger was wrong, the diagram was right | fix the ledger, continue |
| the code is wrong, the diagram was right | fix the code, continue |

Never edit the diagram to match code you just wrote without going back through verification. That converts a design error into a permanent contract error.

## 7. Decide completion

A task is not complete because it compiles or its tests pass. It is complete when every ledger row has evidence.

Required evidence per row:

| Row | Evidence |
| --- | --- |
| Node | artifact path and exporting symbol exist, and the writer is the only mutator |
| Solid edge | emit and receive both located, plus a proof that breaks if either is removed |
| Dotted edge | fact produced, and an observing location that the diagram names |
| `not yet verified` node | still marked, with the downstream task recorded |
| `required_verification` | a `progress.md` record whose `check` matches the id and whose `result` equals `required_result` |

Two rows may honestly stay open:

- a node whose diagram says `not yet verified`, with its owning task;
- an edge owned by a later task that the Workstream diagram explicitly defers.

Anything else open means the task is not done, and `progress.md` status must not say `completed`.

## 8. Record and report

Update `progress.md`:

- `changed_regions` in the same `path + boundary` shape as `owns`, covering exactly the regions the ledger touched;
- `verification` entries for each `required_verification` id;
- `next_action` for anything deferred, naming the owning task.

Report three separate lists. Do not merge them:

1. **implemented and proven** — node and edge, with the proof;
2. **implemented but deferred** — the exact edge or node, the downstream owner, and why it cannot be closed now;
3. **not verified** — what is unproven and what would prove it.

Then re-run `--scope task:<TASK-ID>` and report its exit code unchanged. A task can be complete with exit `1` when the remaining findings are Workstream-attributed; say so explicitly instead of implying a clean pass. An `implemented-edge-without-direct-import` entry is not a finding against the task: the edge is proven by the ledger's emit side, receive side and breaking test, which is exactly what dependency inversion looks like in code.

## Stop conditions

- The ledger needs a node with no artifact, or two writers for one fact.
- An edge needs a crossing the diagram does not draw.
- A half edge cannot be closed by the end of the batch.
- Verification exits `2`.
- The diagram must change but the change is unconfirmed.
- Every remaining ledger row touches a region named in `waiting_for`; the task waits for the active writer's completion fact and then re-reads, as the memory collision protocol defines.

## Prohibited

- Treating a compiled call as an implemented edge when nobody receives it.
- Adding an import, port, alias or re-export the diagram does not draw.
- Stub producers or mock composition to make downstream work proceed.
- Editing the diagram to match finished code without re-verifying it.
- Recording `completed` while a ledger row has no proof.
- Widening `owns` to absorb a finding that belongs to another task.
- Reporting a deferred edge as working because a later task will wire it.
