<div align="center">

<img src="assets/icons/icon.png" width="96" alt="Dline" />

# Dline

**An autonomous coding agent inside VS Code**

Reads and writes files, runs commands, drives a browser, and calls MCP tools — with your approval at every step.

[中文](README.md) | English · [Changelog](docs/changelog/CHANGELOG_en.md) · [Contributing](CONTRIBUTING.md)

</div>

<p align="center"><img src="assets/docs/marketplace/r1-hero.gif" width="1200" alt="Dline completing a coding task end to end" /></p>


## Why Dline

- **Parallel tasks, fully isolated** — run several tasks in one workspace at the same time; each has its own model, capability toggles, checkpoints, and execution state.
- **Pick a model per task** — a lightweight model for research, a stronger one for implementation. Profiles bind to tasks, not to a single global setting.
- **Long tasks keep going** — when context nears its limit, compaction runs in passes, and a mid-way failure resumes instead of restarting.
- **Observable and controllable** — the activity panel shows the running tool, subagent timelines, API rate, and context usage in real time; file edits and commands always wait for your confirmation.
- **Fine-grained permissions** — `.agentignore` limits what the agent can reach along four dimensions: read, write, execute, and visibility.

Dline is a community fork of [Cline](https://github.com/cline/cline). It keeps the original interaction model while rewriting the task runtime, state storage, prompt architecture, context management, and terminal execution, and it runs daily in real production projects.

## Install

### From a VSIX

Load the `.vsix` through VS Code's "Install from VSIX" command, or run:

```bash
code --install-extension <vsix-file>
```

### From source

```bash
npm run install:all
npm run vsix
```

The generated `.vsix` is written to the repository root. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and debugging.

**Requirements**: VS Code 1.134.0 or newer.

**Migrating from Cline**: on first launch, existing Cline data (settings, MCP configuration, rules, and workflows) is copied into the Dline directory. The original data is neither modified nor deleted, so both extensions can coexist. Task history is no longer migrated: Dline's task index and per-task runtime state are no longer compatible with Cline, so imported entries could not be opened or resumed and are left in place.

## Quick Start

1. After installing, click the Dline icon in the activity bar to open the sidebar.
2. Open **API Configuration** in settings and create a profile: choose a provider, enter an API key, and select a model.
3. Describe your task in the input box, choose **Plan** (plan first, then execute) or **Act** (execute directly), and send.

Dline asks for confirmation before reading or writing files, running commands, or calling external tools. Low-risk operations can be auto-approved in settings.

<p align="center"><img src="assets/docs/marketplace/r2-quick-start.gif" width="1200" alt="Configuring a profile and starting the first task" /></p>


## Core Capabilities

### Parallel tasks and task isolation

A single workspace runs multiple tasks at once, fully isolated from each other:

- **Independent profiles** — each task binds its own model and endpoint; switching one task's profile never affects the others.
- **Independent capability toggles** — skills, workflows, MCP servers, and browser access are enabled per task and saved with it.
- **Independent checkpoints** — file ownership is arbitrated per task, so rolling back one task never touches files another task changed.
- **Independent execution state** — cancellation, resume, and approval each form their own chain without cross-talk.

Parallel tasks share one machine, so code search and state persistence run under explicit budgets and scheduling; a repository-wide search does not slow down other tasks or the UI.

<p align="center"><img src="assets/docs/marketplace/r3-parallel-tasks.gif" width="1200" alt="Two tasks running in parallel with different models" /></p>


### Multiple profiles and model providers

Manage several API keys and endpoints at once, and bind them per task, per subagent, or for image generation. API keys live in a dedicated key store, decoupled from profile configuration.

The main task and its subagents do not have to use the same model. Prepare profiles for code discovery, in-depth review, or web research, then bind each named subagent to the appropriate configuration. Enable a profile and check **Subagents** in **API Configuration** to make it selectable in subagent settings. For image generation, configure an image source and image model on that API Profile, reusing its image service or binding a separate Image Profile.

Supports 30+ providers and local runtimes, including OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, AWS Bedrock, Vertex AI, Qwen, GLM, Ollama, and LM Studio. When a model speaks several protocols, you can choose between OpenAI Chat, OpenAI Responses, and Anthropic Chat formats.

### Three scopes for rules, skills, workflows, and MCP

Rules, skills, workflows, MCP servers, and browser access resolve across **global / workspace / task** scopes, each layer overriding the one above:

| Scope | Use case |
|---|---|
| Global | Personal preferences shared across all projects |
| Workspace | Team conventions for the current project, versioned with the code |
| Task | Temporarily enabled or disabled for this task only |

Task-level settings persist with the task and are restored on resume without polluting workspace configuration. Skills, workflows, and MCP tools load on demand instead of consuming context upfront.

<p align="center"><img src="assets/docs/marketplace/r6-capability-scopes.gif" width="1200" alt="Adjusting task-scoped workflows, skills, rules, and MCP servers with a stale Prompt Cache warning" /></p>


### Long tasks and automatic compaction

When context approaches or exceeds the window, Dline compacts the conversation in passes: each pass summarizes only a range that is safe to fold, carries the cumulative summary into the next pass, and repeats until enough context is free to continue. Compaction runs under a budget with failure replay, so a mid-way error resumes instead of starting over.

<p align="center"><img src="assets/docs/marketplace/r8-compaction.gif" width="1200" alt="Task continues after automatic compaction" /></p>


### Live activity panel

The **Work** tab shows the conversation and tool output; the **Activities** tab shows the running tool, subagent call timelines and metrics, API rate and context usage charts, and the full retry sequence for failures. What the agent is doing and how much context it has spent are visible at a glance.

<p align="center"><img src="assets/docs/marketplace/r4-activity-panel.gif" width="1200" alt="Activity panel showing tool execution and context usage" /></p>


### Subagents and task orchestration

Delegate code investigation to subagents and bring back findings instead of the entire reading history. The shipped `default` configuration provides read-only research, background execution, timeouts, and automatic retry of recoverable failures. `use_subagents` runs one to five default subagents per batch.

Named subagents define their role, `profile`, tool allowlist, and visible skills in YAML under `.agents/subagents/`. For example, bind `code-researcher` to a fast discovery profile and `architecture-reviewer` to an in-depth reasoning profile while the main task keeps its implementation profile. A valid explicit binding uses the subagent's own model and Thinking settings. Omitting `profile` inherits the parent task's **Act Profile**, even when the parent is currently in Plan mode.

Combine tools by role: expose `web_search` / `web_fetch` to a web researcher, Skill loading and MCP tools to a specialist, or `generate_image` to an image agent. Search routing and image sources are configured on the bound API Profile. Image agents require an explicit valid profile; a separate Image Profile is linked through that API Profile, not selected by arbitrary credential switching at call time. Tool allowlists do not replace each tool's permission and approval policies.

Call different named agents separately with `use_subagent`. The batch `use_subagents` entry runs only the default configuration, without a different profile per item. To advance implementation as an independent peer task, use `spawn_task` with a Plan or Act starting mode. See the [subagent guide](docs/features/subagents.mdx) for configuration examples and permission boundaries.

<p align="center"><img src="assets/docs/marketplace/r5-subagents.gif" width="1200" alt="Several subagents researching in parallel" /></p>


### Code understanding, editing, and terminal control

- **Semantic code tools** — beyond the usual read, write, search, and command tools, Dline offers LSP-backed reference lookup, semantic rename, and cross-file batch replacement.
- **Terminal control** — commands take a working directory, an execution timeout, and a background handoff duration; long-running commands move to the background with their output preserved and can be terminated at any time. On Windows, PowerShell selection and UTF-8 encoding are handled automatically.
- **Warm terminals** — terminal instances are started ahead of time, so a command takes a ready terminal instead of waiting for shell startup.
- **Terminal environment** — declare environment variables, startup scripts, and pre-commands per platform and shell in `.agents/bashrc.yml` (for example, activating a conda environment), versioned with the project.

### Access permissions

`.agentignore` uses `.gitignore` syntax and removes permissions per dimension instead of merely hiding paths:

```gitignore
secrets/          # remove every permission
vendor/ -w        # read-only, writes rejected
generated/ -s     # hidden from listings and search, still readable by exact path
scripts/ext/ -x   # cannot be used as a command working directory
logs/ -r          # not readable, other permissions kept
```

<p align="center"><img src="assets/docs/marketplace/r7-agentignore.png" width="1200" alt=".agentignore rejecting a write to a read-only directory" /></p>


### Checkpoints and task history

A Git-based checkpoint is created after every tool execution, so file changes can be compared or rolled back at any time. Task history is searchable and resumable; you can keep typing while a task runs — messages queue and arrive at a safe boundary.

<p align="center"><img src="assets/docs/marketplace/r9-checkpoints.png" width="1200" alt="Comparing and restoring a checkpoint" /></p>


### Web search, image generation, and rich rendering

- **Web search and fetch** — routed automatically by the current model's capabilities: hosted execution when the provider offers it, local execution otherwise. Each profile can also be pinned to local only, hosted only, or off.
- **Image generation** — reuse the current OpenAI profile, use the provider's hosted image capability, or bind a standalone OpenAI / Gemini image profile; count, size, quality, format, and background are configurable, and existing images can be edited further.
- **Rich rendering** — ` ```latex ` blocks in the conversation are typeset as formulas, and ` ```mermaid ` blocks render as diagrams that open as SVG in the editor on click.

<p align="center"><img src="assets/docs/marketplace/r10-rich-rendering.png" width="1200" alt="LaTeX formulas and Mermaid diagrams rendered in the conversation" /></p>


## Configuration Directories

| Path | Purpose |
|---|---|
| `.agents/rules/` | Project rules injected into the system prompt |
| `.agents/workflows/` | Reusable multi-step procedures |
| `.agents/skills/` | Task-specific methods and best practices |
| `.agents/subagents/` | Subagent definitions (YAML) |
| `.agents/mcp/` | Workspace-level MCP server descriptors (YAML / JSON) |
| `.agents/bashrc.yml` | Terminal environment configuration |
| `.agentignore` | Agent access permission rules |

`AGENTS.md`, `.clinerules/`, `.cursor/rules/`, `.cursorrules`, `.windsurfrules`, and `.claude/skills/` are also recognized, so existing projects work without migration.

## Privacy and Data

- API keys and credentials are stored only in the local key store; they are never written into profile configuration or task history.
- Code, prompts, and conversation content are sent only to the providers you configure in your profiles.
- Usage reporting and error reporting require separate consent and are off by default; runtime telemetry starts only after you enable them.
- When troubleshooting, a diagnostic bundle can be exported to the local machine in one click. The ZIP contains no code, prompts, or credentials.

## Relationship to Cline

Dline is built on the Apache-2.0 licensed [Cline](https://github.com/cline/cline) project and retains the original copyright, license, and attribution notices. Dline is not the official Cline release and is not published by Cline Bot Inc.; the Cline name is used only to describe project origin and compatibility.

Relative to upstream, Dline has changed more than 2,300 source files and added roughly 300k lines of code. The through-line of that work is **task isolation**: giving every task in a workspace its own profile, capability configuration, checkpoint boundary, and execution state. Dline-specific changes are maintained by the Dline maintainers.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, builds, and debugging, and [src/test/e2e/README.md](src/test/e2e/README.md) for the end-to-end test suite.

## License

[Apache 2.0](LICENSE)
