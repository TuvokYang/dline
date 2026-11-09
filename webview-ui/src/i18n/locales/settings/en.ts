import { en as auth } from "./auth.en"
import { en as common } from "./common.en"
import { en as providers } from "./providers.en"
import { en as sections } from "./sections.en"
import { en as status } from "./status.en"

/** Settings owns display text only; persisted names, enums and external payloads stay outside this resource. */
export const en = { ...common, ...sections, ...providers, ...auth, ...status } as const
