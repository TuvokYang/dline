import { HeroUIProvider } from "@heroui/react"
import { type ReactNode } from "react"
import { ClineAuthProvider } from "./context/ClineAuthContext"
import { ExtensionStateContextProvider } from "./context/ExtensionStateContext"
import { PlatformProvider } from "./context/PlatformContext"
import { UiLanguageBridge } from "./i18n/UiLanguageBridge"

export function Providers({ children }: { children: ReactNode }) {
    return (
        <PlatformProvider>
            <ExtensionStateContextProvider>
                <UiLanguageBridge>
                    <ClineAuthProvider>
                        <HeroUIProvider>{children}</HeroUIProvider>
                    </ClineAuthProvider>
                </UiLanguageBridge>
            </ExtensionStateContextProvider>
        </PlatformProvider>
    )
}
