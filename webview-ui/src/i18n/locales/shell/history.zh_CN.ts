import type { UiResource } from "../../resource"
import type { en } from "./history.en"

export const zhCN = {
    "shell.history.title": "历史",
    "shell.history.searchPlaceholder": "模糊搜索历史…",
    "shell.history.clearSearch": "清除搜索",
    "shell.history.sort.newest": "最新",
    "shell.history.sort.oldest": "最早",
    "shell.history.sort.mostExpensive": "花费最高",
    "shell.history.sort.mostTokens": "Token 最多",
    "shell.history.sort.mostRelevant": "最相关",
    "shell.history.filter.workspaceOnly": "仅当前工作区",
    "shell.history.filter.favoritesOnly": "仅收藏",
    "shell.history.group.today": "今天",
    "shell.history.group.older": "更早",
    "shell.history.selectAll": "全选",
    "shell.history.selectNone": "取消全选",
    "shell.history.deleteSelected": "删除所选项目",
    "shell.history.deleteSelectedCount": ({ count, size }) =>
        `${count > 1 ? `删除 ${count} 个所选项目` : "删除所选项目"}${size === "" ? "" : `（${size}）`}`,
    "shell.history.deleteAll": "删除全部历史",
    "shell.history.deleteAllCount": ({ size }) => `删除全部历史${size === "" ? "" : `（${size}）`}`,
    "shell.history.lockedSingle": "此任务正被另一个实例使用，无法删除。",
    "shell.history.lockedMany": ({ count }) => `${count} 个任务正被另一个实例使用，未被删除。`,

    "shell.historyItem.openTask": "打开任务",
    "shell.historyItem.opening": "正在打开任务",
    "shell.historyItem.openInNewWindow": "在新窗口打开",
    "shell.historyItem.delete": "删除",
    "shell.historyItem.addFavorite": "加入收藏",
    "shell.historyItem.removeFavorite": "取消收藏",
    "shell.historyItem.export": "导出",
    "shell.historyItem.tokens": "Token：",
    "shell.historyItem.model": "模型：",
    "shell.historyItem.size": "大小：",

    "shell.historyOpening.message": "正在打开任务…",

    "shell.completion.completed": "已完成",

    "shell.historyPreview.recent": "最近",
    "shell.historyPreview.viewAll": "查看全部",
    "shell.historyPreview.filterGroup": "最近任务筛选",
    "shell.historyPreview.filter.workspace": "工作区",
    "shell.historyPreview.filter.favorite": "收藏",
    "shell.historyPreview.filter.all": "全部",
    "shell.historyPreview.favorited": "已收藏",
    "shell.historyPreview.lastEdited": ({ timestamp }) => `最后编辑于 ${timestamp}`,
    "shell.historyPreview.empty": "暂无最近任务",

    "shell.taskUsage.totalCost": "总花费",
    "shell.taskUsage.tokens": ({ count }) => `${count} Token`,
    "shell.taskUsage.totalTokens": ({ count }) => `Token 总数：${count}`,
} satisfies UiResource<typeof en>
