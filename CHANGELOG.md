# Changelog

## [0.14.2]

### Added
- 新增 GPT-6.2 Astra、GPT-6.2 Sol 和 GPT-6.1 Terra 模型信息，分别维护 OpenAI API 的分档价格与 ChatGPT 订阅的模型信息。
- OpenAI 兼容服务和 ChatGPT Subscription 的远程模型未声明推理等级时提供默认启用的思考控件和兼容等级选择，未选择等级时保留服务端默认值。
- OpenAI、ChatGPT Subscription、Anthropic 和 Claude Code 的同家族新次版本可继承最近旧目录声明的缓存与思考能力。
- Anthropic 模型没有声明或可继承的思考模式时，可手动启用并选择 Effort 或 Budget。

### Changed
- 根 CHANGELOG.md 与英文入口直接维护当前正文，每种语言使用单一 history 文件，共享提取逻辑并通过显式命令归档。
- 子代理能力标签显示生效数与目录总数，失效项标红，技能和工作流隐藏文件路径，配置面板背景随主题轻微区分。

### Fixed
- 活动摘要将失败次数内联到对应分类的括号中，总数包含失败子集，不再单独追加失败项。
- 目标命令已结束的终止命令行可随活动折叠，运行中、状态未知和待交互的行仍保持可见。
- 已完成的上下文压缩单独计数，不再归入其他操作。
- 修复文件锁恢复时旧持有者可能影响新持有者的问题。
- 修复 OpenAI、OpenRouter/Cline、AIhubmix、Vercel、LiteLLM、OCA 及 Anthropic/Claude Code 将未声明缓存能力误判为关闭的问题，保留明确关闭并统一设置与请求的缺省值。
