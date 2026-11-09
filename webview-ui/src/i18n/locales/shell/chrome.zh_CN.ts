import type { UiResource } from "../../resource"
import type { en } from "./chrome.en"

export const zhCN = {
    "shell.chrome.done": "完成",
    "shell.chrome.close": "关闭",
    "shell.chrome.dismiss": "关闭",
    "shell.chrome.retry": "重试",
    "shell.chrome.cancel": "取消",
    "shell.chrome.copy": "复制",
    "shell.chrome.copied": "已复制",
    "shell.chrome.environment.production": "正式",
    "shell.chrome.environment.staging": "预发布",
    "shell.chrome.environment.local": "本地",
    "shell.chrome.environment.selfHosted": "自托管",
    "shell.chrome.environmentSuffix": ({ environment }) => `${environment}环境`,

    "shell.hydration.pending": "正在加载 Dline…",
    "shell.hydration.slow": "仍在等待扩展发送状态。此次加载比平常更久。",
    "shell.hydration.failed": "Dline 无法加载状态。",

    "shell.errorBoundary.title": "Dline 渲染此面板时遇到错误。",
    "shell.errorBoundary.reload": "重新加载面板",

    "shell.alert.unsavedTitle": "未保存的更改",
    "shell.alert.unsavedDescription": "你有未保存的更改。确定要放弃吗？",
    "shell.alert.discard": "放弃更改",
    "shell.alert.saveContinue": "保存并继续",

    "shell.banner.region": "公告",
    "shell.banner.dismiss": "关闭横幅",
    "shell.banner.previous": "上一条横幅",
    "shell.banner.next": "下一条横幅",

    "shell.image.blocked": "外部图片已阻止，等待你的许可",
    "shell.image.sourceLabel": "来源：",
    "shell.image.altLabel": "替代文本：",
    "shell.image.load": "加载图片",

    "shell.mermaid.generating": "正在生成 Mermaid 图表…",
    "shell.mermaid.copy": "复制代码",
    "shell.latex.copy": "复制 LaTeX 源码",

    "shell.codeAccordian.expand": "展开代码块",
    "shell.codeAccordian.collapse": "折叠代码块",
    "shell.codeAccordian.userEdits": "用户编辑",
    "shell.codeAccordian.consoleLogs": "控制台日志",

    "shell.markdown.copyCode": "复制代码",
    "shell.markdown.actMode.toggle": "点击切换到执行模式",
    "shell.markdown.actMode.already": "已处于执行模式",
    "shell.markdown.actMode.label": "执行模式（⌘⇧A）",
    "shell.markdown.openInEditor": ({ path }) => `在编辑器中打开 ${path}`,

    "shell.openFileLink.aria": ({ name }) => `打开日志文件 ${name}`,
    "shell.openFileLink.title": ({ path }) => `点击打开：${path}`,

    "shell.checkpoint.compare": "比较",
    "shell.checkpoint.restore": "恢复",
    "shell.checkpoint.restoreBoth": "恢复任务与工作区",
    "shell.checkpoint.restoreBothHelp": "将任务和项目文件恢复到此刻拍摄的快照",
    "shell.checkpoint.restoreTask": "仅恢复任务",
    "shell.checkpoint.restoreTaskHelp": "删除此刻之后的消息（不影响工作区）",
    "shell.checkpoint.restoreWorkspace": "仅恢复工作区",
    "shell.checkpoint.restoreWorkspaceHelp": "将项目文件恢复到此刻拍摄的快照（任务可能不同步）",

    "shell.checkmark.label": "检查点",
    "shell.checkmark.compaction": "压缩检查点",
    "shell.checkmark.before": ({ tool }) => `在 ${tool} 之前`,
    "shell.checkmark.partialCoverage": ({ label, available, total, restored }) =>
        `${label}（${available}/${total} 个工作区${restored ? "，已恢复" : ""}）`,
    "shell.checkmark.restored": ({ label }) => `${label}（已恢复）`,
    "shell.checkmark.restoreFilesTask": "恢复文件与任务",
    "shell.checkmark.restoreFilesTaskHelp": "还原文件并清除此刻之后的消息",
    "shell.checkmark.moreOptions": "更多选项",
    "shell.checkmark.restoreFilesOnly": "仅恢复文件",
    "shell.checkmark.restoreFilesOnlyHelp": "将文件还原到此检查点",
    "shell.checkmark.restoreTaskOnly": "仅恢复任务",
    "shell.checkmark.restoreTaskOnlyHelp": "清除此刻之后的消息",
    "shell.checkmark.compactionHelp": "将对话恢复到此轮压缩前的检查点。工作区文件保持不变。",
    "shell.checkmark.taskHelp": "将对话恢复到此检查点。工作区文件保持不变。",

    "shell.resourceChip.openHint": "点击打开。",

    "shell.metric.bar": "柱状图",
    "shell.metric.line": "折线图",
    "shell.metric.history": "指标历史",
    "shell.metric.rpm": "每分钟请求数",
    "shell.metric.tokens": "Token 消耗",
    "shell.metric.tpm": "每分钟 Token 数",

    "shell.thumbnails.imageAlt": ({ index }) => `缩略图 image-${index}`,
} satisfies UiResource<typeof en>
