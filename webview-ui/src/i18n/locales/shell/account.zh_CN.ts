import type { UiResource } from "../../resource"
import type { en } from "./account.en"

export const zhCN = {
    "shell.account.title": "账户",
    "shell.account.personal": "个人",
    "shell.account.role": "角色",
    "shell.account.roleLocked": "当你的组织启用远程配置时，此项无法更改。",
    "shell.account.dashboard": "控制台",
    "shell.account.logOut": "退出登录",
    "shell.account.environment": "Dline 环境",
    "shell.account.optOutRemoteConfig": "退出远程配置",

    "shell.account.welcome.description": "注册账户即可使用最新模型、查看用量与额度的计费控制台，以及更多即将推出的功能。",
    "shell.account.welcome.signUp": "使用 Dline 注册",
    "shell.account.welcome.legal": "继续即表示你同意{terms}和{privacy}。",
    "shell.account.welcome.terms": "服务条款",
    "shell.account.welcome.privacy": "隐私政策",

    "shell.account.credits.label": "当前余额",
    "shell.account.credits.lastUpdated": ({ time }) => `最后更新：${time}`,
    "shell.account.credits.add": "充值额度",

    "shell.account.history.usageTab": "用量历史",
    "shell.account.history.paymentsTab": "付款历史",
    "shell.account.history.loading": "正在加载…",
    "shell.account.history.date": "日期",
    "shell.account.history.model": "模型",
    "shell.account.history.creditsUsed": "已用额度",
    "shell.account.history.totalCost": "总费用",
    "shell.account.history.credits": "额度",
    "shell.account.history.webSearch": "网页搜索",
    "shell.account.history.webFetch": "网页抓取",
    "shell.account.history.webFetchLlm": "网页抓取（LLM）",
    "shell.account.history.emptyUsage": "暂无用量历史",
    "shell.account.history.emptyPayments": "暂无付款历史",

    "shell.account.role.owner": "所有者",
    "shell.account.role.admin": "管理员",
    "shell.account.role.member": "成员",
} satisfies UiResource<typeof en>
