# Changelog

## [Unreleased]

### Added
- Added GPT-6.2 Astra and Sol metadata, separating OpenAI API input-token price bands from ChatGPT Subscription default context windows.
- OpenAI-compatible and ChatGPT Subscription remote models without declared reasoning levels offer thinking enabled by default and compatible effort choices, leaving the endpoint default unchanged when no effort is selected.
- New minor versions in OpenAI, ChatGPT Subscription, Anthropic, and Claude Code can inherit cache and thinking capabilities from the nearest older catalog declaration in the same family.
- Anthropic models without a declared or inherited thinking mode allow manually enabling and selecting Effort or Budget.

### Changed
- The root CHANGELOG.md and English entry hold only current notes, with one history file per language, shared extraction, and explicit archiving commands.
- Subagent capability tabs show active counts against directory totals, mark inactive choices in red, hide Skill and Workflow file paths, and use subtly differentiated theme backgrounds.

### Fixed
- Activity summaries keep failed counts in parentheses within each category's total instead of adding separate failure entries.
- Kill-command rows fold with finished activity once their target command has ended, while running, unknown, and interactive rows remain visible.
- Fixed absent cache metadata being treated as disabled for OpenAI, OpenRouter/Cline, AIhubmix, Vercel, LiteLLM, OCA, and Anthropic/Claude Code, preserving explicit opt-outs and consistent defaults in settings and requests.
