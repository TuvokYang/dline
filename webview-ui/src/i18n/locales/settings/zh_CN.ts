import type { UiResource } from "../../resource"
import { zhCN as auth } from "./auth.zh_CN"
import { zhCN as common } from "./common.zh_CN"
import type { en } from "./en"
import { zhCN as providers } from "./providers.zh_CN"
import { zhCN as sections } from "./sections.zh_CN"
import { zhCN as status } from "./status.zh_CN"

export const zhCN = { ...common, ...sections, ...providers, ...auth, ...status } satisfies UiResource<typeof en>
