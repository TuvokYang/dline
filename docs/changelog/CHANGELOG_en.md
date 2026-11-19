# Changelog

## [Unreleased]

### Added
- Added GPT-6.2 Astra and Sol metadata, separating OpenAI API input-token price bands from ChatGPT Subscription default context windows.
- OpenAI-compatible and ChatGPT Subscription remote models without declared reasoning levels offer thinking enabled by default and compatible effort choices, leaving the endpoint default unchanged when no effort is selected.
- New minor versions in OpenAI, ChatGPT Subscription, Anthropic, and Claude Code can inherit cache and thinking capabilities from the nearest older catalog declaration in the same family, without copying prices, limits, protocols, or hosted tools.
- Anthropic models without a declared or inherited thinking mode allow manually enabling and selecting Effort or Budget without inferring a mode, level, or budget.

### Changed
- The root CHANGELOG.md and English entry hold only current notes, with one history file per language, shared extraction, and explicit archiving commands.

### Fixed
- Fixed absent cache metadata being treated as disabled for OpenAI, OpenRouter/Cline, AIhubmix, Vercel, LiteLLM, OCA, and Anthropic/Claude Code, preserving explicit opt-outs and consistent defaults in settings and requests.
