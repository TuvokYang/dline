import { activityEn } from "./activity.en"
import { commonEn } from "./common.en"
import { errorsEn } from "./errors.en"
import { rowsEn } from "./rows.en"

/**
 * Chat rows, activity and error presentation only.
 *
 * User, model and tool payloads, provider diagnostics, file paths, identifiers,
 * code and third-party descriptions never enter this resource.
 */
export const en = { ...commonEn, ...errorsEn, ...rowsEn, ...activityEn } as const
