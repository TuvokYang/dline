import type { UiResource } from "../../resource"
import type { en } from "./welcome.en"

export const zhCN = {
    "shell.onboarding.step0.title": "你将如何使用 Dline？",
    "shell.onboarding.step0.description": "在下方选择一个选项即可开始。",
    "shell.onboarding.byok.title": "配置你的服务提供方",
    "shell.onboarding.account.title": "就差一步了！",
    "shell.onboarding.account.description": "请在浏览器中完成登录或注册，然后回到这里完成设置。",
    "shell.onboarding.button.continue": "继续",
    "shell.onboarding.button.back": "返回",
    "shell.onboarding.changeLater": "你稍后可以在设置中更改",
    "shell.onboarding.userType.account.title": "登录 / 注册账户",
    "shell.onboarding.userType.account.description": "使用你的账户使用 Dline",
    "shell.onboarding.userType.byok.title": "使用自己的 API 密钥",
    "shell.onboarding.userType.byok.description": "使用你选择的服务提供方使用 Dline",

    "shell.welcome.heading": "有什么可以帮你？",
    "shell.welcome.headingLazy": "我大概就是来帮忙的吧",
    "shell.welcome.takeTour": "快速导览",
    "shell.welcome.quickWins.heading": "用 Dline {accent}",
    "shell.welcome.quickWins.accent": "轻松搞定",

    "shell.welcome.quickWin.nextjs.title": "构建 Next.js 应用",
    "shell.welcome.quickWin.nextjs.description": "用 Next.js 和 Tailwind 创建一个漂亮的笔记应用",
    "shell.welcome.quickWin.cli.title": "打造 CLI 工具",
    "shell.welcome.quickWin.cli.description": "开发一个功能强大的终端 CLI，自动完成一项有趣的任务",
    "shell.welcome.quickWin.game.title": "开发一个游戏",
    "shell.welcome.quickWin.game.description": "编写一个可在浏览器中运行的经典贪吃蛇游戏。",

    "shell.welcome.legacy.intro": "你好，我是 Dline",
    "shell.welcome.legacy.capability":
        "借助 {model} 的智能体编程能力突破，以及可创建和编辑文件、探索复杂项目、使用浏览器并执行终端命令的工具，我能完成各类任务{permission}。我甚至可以使用 MCP 创建新工具并扩展自身能力。",
    "shell.welcome.legacy.modelLink": "Claude 4.6 Sonnet",
    "shell.welcome.legacy.permission": "（当然，是在你允许的前提下）",
    "shell.welcome.legacy.signUp": "注册账户即可免费开始使用，或使用可访问 Claude Sonnet 等模型的 API 密钥。",
    "shell.welcome.legacy.getStarted": "免费开始使用",
    "shell.welcome.legacy.useOwnKey": "使用自己的 API 密钥",
    "shell.welcome.legacy.letsGo": "开始吧！",

    "shell.whatsNew.title": ({ version }) => `🎉 v${version} 新功能`,
    "shell.whatsNew.changelog": "查看{link}了解全部变更。",
    "shell.whatsNew.changelogLink": "完整更新日志",
    "shell.whatsNew.starAria": "在 GitHub 上为我们加星",
    "shell.whatsNew.star": "请通过{link}支持 Dline。",
    "shell.whatsNew.starLink": "在 GitHub 上为我们加星",
} satisfies UiResource<typeof en>
