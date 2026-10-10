中文 | [English](WHATS_NEW_en.md)

# 新功能

Dline 侧边栏的 What's New 对话框展示本目录下英文版 `WHATS_NEW_en.md` 中最新的版本段落，本文件是与之对应的中文版本。Webview 构建时读取英文版，修改随下一次构建发布。完整变更见 [更新日志](../../CHANGELOG.md)。

<!--
格式规则（由 webview-ui/vite-whats-new.ts 在构建时校验英文版，并由测试校验两个版本一致）：
- 每个版本以不带其他字符的 "## X.Y.Z" 标题开头，最新版本在最前。第一个 "##" 标题就是被发布的版本，
  不要在它上方放置其他 "##" 标题。
- 每个版本只包含一个平铺的 "- " 列表，续行至少缩进两个空格。
- 行内语法仅限 **粗体**、`代码` 和 [文本](https://...) 链接，且不能嵌套。
- 每次版本更新都要在这里新增一个版本段落。最新版本必须与 package.json 的版本号完全一致，并与 WHATS_NEW_en.md
  保持相同的版本号和相同的条目数量，两项均由单元测试校验。
-->

## 0.11.0

- **可靠的长任务恢复**：上下文压缩使用 Provider 计数或真实用量校准，持久保存已接受的 Pass，并从安全 checkpoint 继续。
- **安全的请求重试**：普通任务和 Subagent 遇到上游 HTTP/2 流错误时会有界重试，手动 Retry 可接管等待中的自动重试。
- **清晰的工具输出**：长 `qna_respond`、`generate_report` 和 `attempt_completion` 回复持续显示，MCP 多响应聚合为单张卡片。
- **简洁的 Thinking 与 checkpoint**：加密 reasoning 只显示单一临时 Thinking，密文不进入界面，同一用户轮次只展示一个恢复基线。
- **稳定的编辑、历史与成本显示**：Background Edit 不再抢焦点，恢复界面不再出现空白行或过期状态，Subagent 使用实际模型币种。

## 0.10.0

- **并行工具调用**：同一轮中无需人工审批的工具调用可以并发执行，最大并行数可配置。
- **更大的子代理批次**：`use_subagents` 单次最多运行 32 个子代理，每个子代理可分别指定 Agent、Profile 与超时。
- **Claude Code 与 Anthropic**：支持 OAuth 登录、托管 Web Search 与 Web Fetch，并以 Claude Opus 5.5 作为默认模型。
- **更丰富的附件**：PDF 作为原生文档完整发送，任意文本文件都可以粘贴或拖放到输入框。
- **可靠性**：历史任务重新打开更快，上下文压缩更稳健，TPM 只统计输出 Token。
