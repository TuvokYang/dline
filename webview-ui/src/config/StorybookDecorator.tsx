import "../../../node_modules/@vscode/codicons/dist/codicon.css"
import "../../../node_modules/@vscode/codicons/dist/codicon.ttf"
import "../../src/index.css"

import { cn } from "@heroui/react"
import type { Decorator } from "@storybook/react-vite"
import React from "react"
import { ClineAuthContext, ClineAuthContextType, ClineAuthProvider, useClineAuth } from "@/context/ClineAuthContext"
import {
    ExtensionStateContext,
    ExtensionStateContextProvider,
    ExtensionStateContextType,
    useExtensionState,
} from "@/context/ExtensionStateContext"
import { StorybookThemes, TOOLKIT_TOKEN_MIRRORS } from "../../.storybook/themes"

/** Properties the last applied palette wrote, so switching themes cannot strand a stale value. */
const previousPalette = { current: [] as string[] }

/**
 * Apply the selected mock theme to the document root.
 *
 * The palette is written on every mount and every theme change, and it first
 * removes whatever the previous palette declared. Toolkit web components such as
 * `vscode-dropdown` style themselves from `--vscode-*` custom properties and
 * silently fall back to their own dark defaults when one is missing, so a
 * leftover or absent variable is the difference between a light control and an
 * opaque dark box.
 */
const ThemeHandler: React.FC<{ children: React.ReactNode; theme?: string }> = ({ children, theme }) => {
    // Derived during render so a palette edit under HMR is picked up even when
    // the toolbar selection itself did not change.
    const styles = theme?.includes("light") ? StorybookThemes.light : StorybookThemes.dark

    React.useLayoutEffect(() => {
        const root = document.documentElement
        const previous = previousPalette.current

        for (const property of previous) {
            if (!(property in styles)) root.style.removeProperty(property)
        }
        for (const [property, value] of Object.entries(styles)) {
            root.style.setProperty(property, value)
        }

        document.body.style.backgroundColor = styles["--vscode-editor-background"]
        document.body.style.color = styles["--vscode-editor-foreground"]
        document.body.style.fontFamily = styles["--vscode-font-family"]
        document.body.style.fontSize = styles["--vscode-font-size"]

        /*
         * The toolkit mirrors `--vscode-*` into its own design tokens from a
         * listener registered on `window.load`. Storybook loads story modules on
         * demand, so a `vscode-dropdown` or `vscode-text-field` first imported
         * after that event never receives the palette and keeps the dark values
         * compiled into its stylesheet. Writing the token custom properties
         * ourselves makes every toolkit control follow the selected theme
         * regardless of when its module happened to load.
         */
        const palette: Record<string, string> = styles
        for (const [toolkitToken, vscodeVariable] of Object.entries(TOOLKIT_TOKEN_MIRRORS)) {
            const value = palette[vscodeVariable]
            if (value === undefined) continue
            root.style.setProperty(`--${toolkitToken}`, value)
            previousPalette.current.push(`--${toolkitToken}`)
        }

        previousPalette.current = [...previousPalette.current, ...Object.keys(styles)]
    }, [styles])

    React.useEffect(
        () => () => {
            for (const property of previousPalette.current) document.documentElement.style.removeProperty(property)
            previousPalette.current = []
        },
        [],
    )

    return <>{children}</>
}
function StorybookDecoratorProvider(className = "relative"): Decorator {
    return (story, parameters) => {
        return (
            <div className={className}>
                <ExtensionStateContextProvider>
                    <ClineAuthProvider>
                        <ThemeHandler theme={parameters?.globals?.theme}>{React.createElement(story)}</ThemeHandler>
                    </ClineAuthProvider>
                </ExtensionStateContextProvider>
            </div>
        )
    }
}

// Wrapper component to safely use useExtensionState inside the provider
const ExtensionStateProviderWithOverrides: React.FC<{
    overrides?: Partial<ExtensionStateContextType>
    children: React.ReactNode
}> = ({ overrides, children }) => {
    const extensionState = useExtensionState()
    return <ExtensionStateContext.Provider value={{ ...extensionState, ...overrides }}>{children}</ExtensionStateContext.Provider>
}

const ClineAuthProviderWithOverrides: React.FC<{
    overrides?: Partial<ClineAuthContextType>
    children: React.ReactNode
}> = ({ overrides, children }) => {
    const authContext = useClineAuth()
    return <ClineAuthContext.Provider value={{ ...authContext, ...overrides }}>{children}</ClineAuthContext.Provider>
}

export const createStorybookDecorator =
    (overrideStates?: Partial<ExtensionStateContextType>, classNames?: string, authOverrides?: Partial<ClineAuthContextType>) =>
    (Story: any) => (
        <ExtensionStateProviderWithOverrides overrides={overrideStates}>
            <ClineAuthProviderWithOverrides overrides={authOverrides}>
                <div className={cn("max-w-lg mx-auto", classNames)}>
                    <Story />
                </div>
            </ClineAuthProviderWithOverrides>
        </ExtensionStateProviderWithOverrides>
    )

export const StorybookWebview = StorybookDecoratorProvider()
