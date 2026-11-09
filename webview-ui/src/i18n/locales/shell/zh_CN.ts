import type { UiResource } from "../../resource"
import { zhCN as account } from "./account.zh_CN"
import { zhCN as chrome } from "./chrome.zh_CN"
import type { en } from "./en"
import { zhCN as history } from "./history.zh_CN"
import { zhCN as navigation } from "./navigation.zh_CN"
import { zhCN as welcome } from "./welcome.zh_CN"
import { zhCN as worktrees } from "./worktrees.zh_CN"

export const zhCN = {
    ...navigation,
    ...chrome,
    ...history,
    ...account,
    ...welcome,
    ...worktrees,
} satisfies UiResource<typeof en>
