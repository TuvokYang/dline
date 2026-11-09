import { en as account } from "./account.en"
import { en as chrome } from "./chrome.en"
import { en as history } from "./history.en"
import { en as navigation } from "./navigation.en"
import { en as welcome } from "./welcome.en"
import { en as worktrees } from "./worktrees.en"

/** Shell and secondary-view display text only; task titles, paths and payloads stay outside this resource. */
export const en = { ...navigation, ...chrome, ...history, ...account, ...welcome, ...worktrees } as const
