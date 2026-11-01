---
name: verify-architecture-diagrams
description: Verify a Workstream or task diagram set top-down for acyclic dependencies, declared layer refinement, task-to-Workstream coverage, cross-task conflicts and recorded implementation gates, reporting blocking, pending, unverifiable, not-checked and tooling findings with a deterministic exit code; use it before implementing against a diagram, and do not use it to author or redesign diagrams.
---

# Verify Architecture Diagrams

Run the verifier, read its five report sections, and act on the finding that owns the defect. Do not repair a lower layer to make an upper-layer finding disappear.

Companion skill: `designing-workstream-diagrams` owns how a diagram set is authored. This skill only decides whether an existing set holds.

## 1. Run it

Only a spec whose first non-empty body line after the H1 is exactly `Architecture-Mode: diagram-driven-v1` is applicable. Missing mode is `not_applicable`; an unknown mode is a warning; duplicated, misplaced or malformed declarations are tooling errors.

```bash
node .agents/skills/verify-architecture-diagrams/scripts/verify-diagrams.mjs \
  --workstream .memory-bank/workstreams/<WS-dir> \
  [--scope all|workstream|task:<TASK-ID>|cross-task|code-conformance] \
  [--json] [--no-self-test]
```

| Option | Meaning |
| --- | --- |
| omitted / `--scope all` | Workstream, every current Task in sorted order, cross-task, then code conformance; one deduplicated report |
| `--scope workstream` | Workstream spec diagrams: parsing, cycles, intra-diagram structure, inter-level refinement |
| `--scope task:<ID>` | one task: its own diagrams, its Workstream mapping, then its recorded implementation gate |
| `--scope cross-task` | the plan's `Depends On` against Workstream reachability, then horizontal comparison across every task diagram |
| `--json` | schema-versioned machine report with coverage, self-test evidence, metrics and findings; exit code is unchanged |
| `--no-self-test` | skip the vendored Tree-sitter mutation self-test; coverage becomes incomplete and the run cannot be `conformant` |

Task diagrams are read from each task's `plan.md` only.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | no blocking, unverifiable or tooling findings |
| `1` | at least one blocking or unverifiable finding |
| `2` | tooling problem; the design verdict is withheld |

`2` outranks `1`: when the verifier itself is unsound, its design conclusion is not evidence.

## 2. Stage order

Stages run top-down. A later stage never compensates for an earlier failure.

```
0  parse            1  cycles (solid edges, by kind)   2  intra-diagram structure
3  B1 L0 -> L5      4  B2 task vs Workstream          5  B3 Depends On and task vs task
6  recorded implementation gate (Tree-sitter)         7  bounded diagram-code conformance
```

## 3. Stage 0: parsing

The parser accepts a declared Mermaid subset: `flowchart`/`graph` with any direction, the standard node shapes, `-->`, `---`, `-.->`, `==>`, `|label|` and inline edge labels, quoted and unquoted node labels, `subgraph`/`end`, `%%` comments and annotations, plus `style`/`classDef`/`class`/`linkStyle`, which are ignored.

A statement outside that subset becomes a **tooling problem**, never a design finding. Report it to the user as a tool defect and extend the parser rather than "fixing" the diagram to match a parser bug.

Annotations the verifier reads:

| Annotation | Effect |
| --- | --- |
| `%% id: <diagram-id>` | stable identity; a duplicate id in one set is blocking; a layered diagram without one is reported once as not checked |
| `%% layer: L<n>` | enables inter-level checks; without it, refinement is unverifiable |
| `%% kind: structure\|flow` | selects the cycle rule; omitted means structure and is reported once as not checked; any other value is blocking |
| `%% refines: <id>[, <id>]` | declares the coarser diagram(s); an unknown id is blocking; without it the pairing is inferred and its findings are reported for review only |
| `%% answers: <question>` | recorded in the report; several lines accumulate; missing is not checked |
| `%% cycle: allowed nodes=A|B owner=<task> reason="<why>"` | exempts exactly the named structure SCC; missing nodes, owner or reason, duplicate node sets, and declarations that match no SCC are blocking |
| `%% module: <node> = <path>` | compatibility shorthand for one declaration/present artifact |
| `%% artifact: <node> role=<role> path=<path> [symbol=<symbol>] [expect=present\|absent\|generated]` | repeatable node artifact; unknown node, role or expectation is reported |
| `%% concept: <node> = <ConceptName>` | gives a node its cross-diagram identity; resolved before id and label |
| `%% local-only: <node>` | exempts a task node from Workstream existence checks |
| `%% note-node: <node>` | excludes a visible constraint node from isolation and graph checks; naming a node the diagram does not draw is blocking |
| `%% ignore: owner=<task> reason=<why>` | skips a diagram; missing owner or reason is itself blocking |
| `%% note: <text>` | prose; never expressed as an edge |

## 4. Stage 1: cycle detection

Two graphs are built from one diagram, and which one must be acyclic depends on the diagram kind.

| Graph | Edges | Cycle allowed |
| --- | --- | --- |
| dependency graph of a `structure` diagram | `-->` solid only | no |
| step graph of a `flow` diagram | `-->` solid only | yes, when every loop has a solid edge leaving it |
| fact and constraint graph | `-.->` dotted only | yes |

- In a structure diagram a solid self-loop or a solid cycle of any length is **blocking**, reported with its full path.
- In a flow diagram a loop with an exit is accepted and counted once as not checked; a loop with no solid edge leaving it is **blocking** (`flow-loop-without-exit`) because the protocol cannot converge.
- Dotted edges are never part of cycle detection. A request/response pair is `A --> B` plus `B -.-> A`; that is the control model, not a defect.
- A genuinely required structure cycle must be declared as `%% cycle: allowed nodes=A|B owner=<task> reason="<why>"`. The sorted node set must exactly equal one detected SCC; one declaration never exempts another SCC. Missing fields, duplicate node sets and unmatched declarations are blocking.
- Note nodes are excluded from both graphs.

## 5. Stage 2: intra-diagram structure

| Rule | Severity |
| --- | --- |
| `subgraph` names an undeclared parent | blocking |
| `subgraph` has no lifetime label | blocking |
| Nodes with no edge at all and not declared `%% note-node:` | blocking, one finding per diagram |
| Solid edge without a label | blocking, one finding per diagram |
| A structure diagram at L0 or L1 whose solid labels use **none** of the declared categories | blocking, one finding per diagram |
| A descriptive label begins with an exact declared category followed by whitespace | checked as that category; substring matches do not qualify |
| Other descriptive labels while the diagram uses declared categories | not checked; no category is guessed |
| Explicitly typed flow diagrams or diagrams below L1 | ownership vocabulary is not an applicable obligation; labels, fact semantics, cycles and refinement are still checked |
| Dotted label that is an instruction | blocking |
| Dotted label that is neither a fact nor a constraint | unverifiable |
| Solid edge crossing unrelated lifetimes without commit or write semantics | not checked, for review |

Three decisions are deliberate:

1. **The normative label sentence names meaning categories, not an exhaustive vocabulary.** An exact leading category such as `injects immutable configuration` has a mechanically checked category identity; `notinjects` does not. Other descriptive labels are not silently promoted to checked categories.
2. **The sentence binds ownership and control composition, which only L0 and L1 structure diagrams express.** A hot-path, failure or delivery diagram describes behaviour and is not held to it.
3. **Lifetime containment is not declared by the spec.** Two subgraphs in one diagram may legitimately nest. Crossing them is therefore a review item rather than a defect.

## 6. Stage 3: B1 inter-level refinement

A finer layer may refine a coarser one. It may not invent authority, scope, direction or style.

Pairing comes from `%% refines:`. When a diagram declares none, the verifier pairs it with the single coarser diagram that overlaps it most and downgrades every `unverifiable` finding of that pair to `not checked`, because a guessed anchor cannot support a blocking verdict. A declared pairing keeps full severity.

| Rule | Severity |
| --- | --- |
| `%% refines:` names an id no layered diagram declares | blocking |
| Fine layer is not finer than its reference | blocking |
| Fine node is neither an id, a normalized label, nor `local-only` | unverifiable |
| Solid fine edge inverts the coarse solid direction | blocking |
| Solid fine edge has no coarse counterpart | unverifiable |
| Coarse solid command drawn as a fine fact edge | blocking |
| Coarse fact edge drawn as a fine command edge | blocking |
| Fine subgraph introduces a lifetime absent from the coarse layer | unverifiable |
| Coarse node never appears in any declared descendant refinement | not checked; sibling selective views are evaluated collectively, inferred pairs do not prove coverage |
| Coarse edge has no nonzero same-style path in any declared descendant refinement | unverifiable; placing the endpoints in disconnected selective views does not prove the relationship |
| Additional fine fact has no coarse fact counterpart | not checked; reverse direction and a fact/constraint label do not prove a missing coarse contract |
| A layer is skipped | unverifiable |

## 7. Stage 4: B2 task diagram against the Workstream

Attribution rule: **existence defects belong to the Workstream; coverage defects belong to the task.**

| Rule | Attribution |
| --- | --- |
| Task node absent from the Workstream and not `local-only` | task |
| Task draws a solid edge the Workstream does not declare | task |
| Task inverts a Workstream solid direction | task |
| Task subgraph absent from the Workstream and not `local-only` | task |
| Task adds a dotted fact edge | not checked |
| Task solid label outside the declared categories | task |
| `not yet verified` node that names no owning task | unverifiable |

A task diagram that shares no node with any Workstream diagram is unverifiable: it is not anchored to the contract at all.

## 8. Stage 5: B3 Depends On and task against task

The plan's Task Graph is checked first: when B depends on A, a solid path through the merged Workstream diagrams must lead from a node A draws to a node B draws (identity: concept, then normalized label, then id). A dependency the diagrams cannot explain is `unverifiable` (`depends-on-not-explained-by-diagram`); a dependency involving a task with no anchored diagram is counted once as not checked; a cross-Workstream dependency (`WS-xxx/TASK-yyy`) is not judged locally.

| Rule | Severity |
| --- | --- |
| Two tasks draw the same edge in opposite directions | blocking |
| Two tasks both commit to the same node | blocking, split authority |
| Merging the task graphs forms a solid cycle | blocking, the task cut is wrong |
| The same node is drawn with different shapes | unverifiable |
| A task participates while its own gate is postponed | pending |

## 9. Stage 6: recorded implementation gate

The gate separates **read-only implementation inspection** from **readiness for conformance**. An implemented Task may be checked before its status becomes completed; otherwise requiring conformance before completion creates a record cycle. The verifier never changes Task status, clears blockers, or converts inspection into completion.

| Condition | Effect |
| --- | --- |
| `progress.md` `status` is not `active`, `blocked` or `completed` | implementation checks postponed |
| `blockers` is not empty | conformance remains pending; read-only inspection may run to establish the evidence needed to resolve the blocker |
| `waiting_for` is not empty | postponed; coordination is normal |
| a `Depends On` task is not `completed` | postponed |
| a `required_verification` id has no `progress.md` record | postponed |
| no required record has `required_result` and a nonempty conclusion | postponed; the conclusion must support the declared claim, subject to evidence review |

Inspection requires an implementation status, no coordination wait, completed upstream dependencies, and all required verification records. A blocker does not suppress that inspection, but still produces pending findings and prevents conformance. After the owning checks actually resolve a blocker, update the authoritative progress record and rerun; never predeclare completion to enable checking.

The code checks are:

| Check | Severity |
| --- | --- |
| `owns[].path` with `kind: module` does not exist | unverifiable |
| `owns[]` with `kind: symbol`: every exact qualified selector has a declaration fact | proven; an empty selector or absent capture is unverifiable; a class declaration never substitutes for its member |
| `%% module:` binding points at a missing module | unverifiable |
| A drawn solid edge whose source module never imports the target module | not checked; dependency inversion is the prescribed shape, so the edge is proven by the task's execution ledger (emit side, receive side, breaking test), not by an import |
| `kind: structured_node` / `section` / `line_range` / `whole_file` | checked for path existence only |
| Mutation self-test does not detect a seeded defect | tooling problem, exit code 2 |

Record contradictions are reported with `[record]` attribution and are blocking, because a completed task contradicting its own record cannot be trusted:

- `status: completed` but a required verification is not satisfied;
- `status: completed` with a non-empty `blockers` or `waiting_for`;
Additional diagnostic verification IDs are allowed and do not create completion requirements. They cannot satisfy a differently named required check; Architecture Evidence still rejects an edge proof ID absent from `required_verification`.

A stale `status.yml` projection is **not** a defect. `progress.md` is authoritative; the mismatch is listed under stale projections and never changes the exit code.

## 10. Bounded diagram-code conformance

The verification unit is the architectural relationships inside the declared Workstream boundary, not every source edit. It includes responsibility and state ownership, dependency direction, interfaces and injection, data and control flow, lifetimes, actual calls and their order, and relationships missing from the diagram. These are not a closed checklist: check both the drawn claims and the actual architecture within the boundary.

Workstream and Task module/function/interface mappings define the inspection subjects. Exact function symbols select their actual source definitions; a module binding selects its declared module. Missing, incorrectly qualified or ambiguous symbols remain unverifiable. Actual dependencies originating inside a bound subject are compared with diagram/interface contracts, so a relationship need not have been drawn to be detected. Shared-file references retain the emitting Task identity and cannot inherit another Task's read contract.

Architecture Evidence artifacts default to `inspection: subject`. An explicit `inspection: support` keeps endpoint existence, exact definitions, edge identity, wiring, direction and writer checks, but does not turn an existing integration container into an audit emitter for unrelated implementation dependencies. Unknown inspection modes are invalid. A subject directory expands to its production source files; tests/fixtures and build/dependency directories are excluded unless mapped as explicit files. A support directory does not imply recursive source inspection; proof endpoints must name their concrete source file.

Task `changed_files` and `changed_regions` are implementation records, not mandatory diagram-verifier input. The verifier does not require a per-edit AST registry, interpret prose scope descriptions as code selectors, or promote unrelated tests/tooling into subjects merely because they changed. `owns` remains write permission; `reads` supplies supporting interfaces, not additional audit emitters. A code-only caller without diagram artifacts may supply explicit module/whole-file boundaries; this does not interpret prose sections as executable selectors.

From bound sources and explicit supporting interfaces, the Skill builds a bounded Tree-sitter closure for binding provenance and cycle-closing context. Support code is not recursively promoted into audit subjects. A cycle containing an in-boundary reference remains checked even when it closes through a supporting interface; unrelated support-only components do not become findings. Unknown references, missing definitions, reversed dependencies and conflicting authorities remain actionable. No target module is executed, and no target compiler/package is required.

Architecture Evidence is the sole Task-local diagram-to-code fact source. Every node and relationship in the selected Task diagram, including dotted result/data flows, must have a mapping; checking an evidence subset does not cover the rest of the graph. Schema v2 gives every node artifact a Workstream-stable `id`; each edge endpoint is `{node, artifact}` and must resolve to the edge's source/target node and the required role (`emitter`, `receiver`, `declaration` contract or `assembly`). Endpoint-local paths or symbols are rejected so an unrelated file cannot prove an edge. Schema v1 remains readable only for migration and cannot establish completed conformance. Evidence validates exact diagram edge identity and supports `direct_import`, `injected_port`, `composition`, `event`, `callback` and canonical Proto `rpc` proofs. `owns` is write permission, not artifact existence or writer authority.

Completed expectation, direct-runtime contradiction, prohibited runtime SCC, conflicting completed writer claims and computable completed boundary overlaps block. Unfinished expectations warn. A `direct_import` can prove its structural import relation, never a runtime delivery claim. Composition imports alone cannot prove construction or connected instance identity. Missing direct imports do not contradict contextual or injected bindings; unsupported composition, injected-port, event, callback and RPC delivery remains `unverifiable`. Actual code edges absent from the current WS contract warn; type-only and external-package facts never become runtime writer/cycle blockers.

Diagram dependency counterparts and Task `reads` contracts are matched to the actual emitting Task, not merged into a Workstream-global permission set. Internal dependencies within one explicitly mapped module/node do not require invented cross-node arrows; they remain subject to cycle checks. File or directory paths cover only their exact path or descendants at a path-segment boundary; `contracts` does not cover `contracts-old`. This records a declared read dependency, not execution, injection or write authority. A shared-file Task cannot inherit another Task's counterpart/read contract merely because their importer path is the same. A `direct_import` with an exact emitting symbol checks uses inside that definition, not imports borrowed from sibling functions; it still proves only a structural dependency, not a method call or delivery.

Canonical RPC prerequisites require a unique service and method, the exact service declaration file, and request/response message identities resolved through Proto namespace and import visibility. An unimported same-name type, ambiguous declaration or enum cannot satisfy a message identity. These facts are necessary prerequisites, never endpoint delivery evidence.

Script wiring certificates admit only explicitly checked syntax subsets. The constructed-event subset requires inert module initialization, a straight-line local construction with an empty constructor, and a direct typed call with the original parameter. The JSX subset requires a directly returned mount, exact component binding, directly returned consumer markup and callback registration at a supported intrinsic event attribute. A tree-wide occurrence is not registration or invocation evidence. General call/value exploration is diagnostic: unknown branches, Promise settlement, abrupt completion, object escapes and unmodelled mutation cannot issue a delivery certificate. Unsupported real code remains unverifiable until a sound adapter covers its actual circuit; never rewrite product code to fit the subset.

Identity is shared by every stage: concept, exact id, then NFKC/lowercase Unicode letter-number label. Multiple candidates are ambiguity, never a guess. Depends On requires an artifact-owned upstream node to reach an artifact-owned downstream node through at least one solid edge.

## 11. Node identity

```
1. declared concept match (%% concept: on the fine node, against the coarse node's concept, id or label)
2. exact id match
3. normalized label match (whitespace, case and punctuation removed)
4. otherwise unresolved -> unverifiable
```

Level 1 lets one concept carry different ids and label suffixes across diagrams without being read as several authorities. Level 3 keeps a renamed node from being read as a newly invented authority. Level 4 refuses to guess.

## 12. Report sections

```
Tooling problem   tool defect; design verdict withheld; exit code 2
Blocking          [diagram], [record] or [code] contradiction
Warning           incomplete or diagram-undeclared implementation; exit remains 0
Pending           postponed work with its reason
Unverifiable      an undecidable relation; still blocks
Not checked       skipped checks, exemptions, accepted descriptive labels
Not applicable    exact opt-in marker is absent
```

Rule of thumb when reading: a finding is repaired at the layer that owns it. A `[diagram]` finding in stage 3 or 4 is repaired in the coarser diagram, not in the task.

Verdicts are `conformant | incomplete | not_applicable | failed | tooling_error`. `conformant` additionally requires delivery coverage: `--scope all`, every required scope executed, and the default Skill-local self-test passed. Focused scopes and `--no-self-test` are diagnostic only. Warning, pending and not-checked produce `incomplete` but do not change the 0/1/2 exit code.

## 13. Anti-patterns

| Symptom | Correct response |
| --- | --- |
| relaxing a rule because a real spec trips it many times | check whether the rule models a fact the spec declares; if not, downgrade the rule, not the spec |
| declaring `%% kind: flow` on a dependency diagram to hide a cycle | the kind must match what the edges mean; a module cycle in a "flow" diagram is still a split authority |
| adding `%% concept:` to force two different authorities to resolve as one | a concept is one thing; two writers under one concept is the split authority B3 reports |
| deleting a task diagram to clear stage 6 | the task then has no anchor, which is unverifiable, not clean |
| treating `not checked` or `unverifiable` as a pass | exit code 1 already treats unverifiable as blocking |
| fixing `status.yml` to silence a projection mismatch | `progress.md` is authoritative; repair the projection, never the exit code |
| adding `%% cycle: allowed` to every cycle | an exemption without an owner and a reason is itself blocking |
| running only `--scope task:<ID>` and reporting success | task scope never proves the Workstream contract |
