import type { UiResource } from "../../resource"
import { activityZhCN } from "./activity.zh_CN"
import { commonZhCN } from "./common.zh_CN"
import type { en } from "./en"
import { errorsZhCN } from "./errors.zh_CN"
import { rowsZhCN } from "./rows.zh_CN"

export const zhCN = { ...commonZhCN, ...errorsZhCN, ...rowsZhCN, ...activityZhCN } satisfies UiResource<typeof en>
