# Functional E2E

This directory contains stable, focused VS Code E2E regressions grouped by owning domain:

- `api/`: providers, request/response contracts, caching, reasoning, telemetry, image generation, and Web tools.
- `capabilities/`: MCP, server tools, Rules, Workflows, Skills, and capability toggles.
- `chat/`: composer behavior, message windows, rendering, panels, commands, completions, and tool presentation.
- `context/`: context accounting, compaction, condense, focus-chain history, mode changes, and recovery.
- `harness/`: fixture isolation, Mock Provider protocols, profile preprocessing, live-profile opt-in, startup dependencies, and workspace layouts.
- `performance/`: latency, concurrency, resource growth, and bounded runtime behavior.
- `profiles/`: model configuration, profile catalogs and switching, persistence, environment management, and Settings UI.
- `tasks/`: lifecycle, history, interactions, checkpoints, tools, subagents, approvals, and recovery controls.

Tests should assert user-visible controls, settings effects, input/output behavior, and only the minimum provider contract required by the scenario. Daily end-to-end user journeys belong in `../work/`; development-only fault injection and forensic diagnostics belong in `../dev/`.
