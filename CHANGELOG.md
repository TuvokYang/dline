# Changelog

## [Unreleased]

### Added
- 智谱 GLM 模型把工具调用写成正文中的 `<tool_call>` 标记时，改为按工具调用执行，不再当作普通文本输出。
- 环境信息块新增 Workspace Recovery 段，向模型公开检查点当前是否启用。

### Fixed
- 修复模型把依赖安装等项目内操作当作必须硬停的外部操作，导致在 git 或检查点恢复保障下任务反复中断打转的问题。
- 修复长对话任务打开 API Rate History 时长时间停在加载状态的问题：读取窗口改为按轮数预算截断，超长历史也能在 Webview 超时前返回，且不再因同一轮存有多个 revision 而丢失历史覆盖。
