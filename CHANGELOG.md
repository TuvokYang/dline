# Changelog

## [Unreleased]

### Added
- 新增 GPT-6.2 Astra、Sol 模型信息，区分 OpenAI API 的输入分档价格与 ChatGPT Subscription 的默认上下文窗口。
- OpenAI 兼容服务和 ChatGPT Subscription 的远程模型未声明推理等级时提供默认启用的思考控件和兼容等级选择，未选择等级时保留服务端默认值。
- OpenAI、ChatGPT Subscription、Anthropic 和 Claude Code 的同家族新次版本可继承最近旧目录声明的缓存与思考能力，不复制价格、限制、协议或托管工具。
- Anthropic 模型没有声明或可继承的思考模式时，可手动启用并选择 Effort 或 Budget，不自动推断模式、等级或预算。

### Changed
- 根 CHANGELOG.md 与英文入口直接维护当前正文，每种语言使用单一 history 文件，共享提取逻辑并通过显式命令归档。

### Fixed
- 修复 OpenAI、OpenRouter/Cline、AIhubmix、Vercel、LiteLLM、OCA 及 Anthropic/Claude Code 将未声明缓存能力误判为关闭的问题，保留明确关闭并统一设置与请求的缺省值。
