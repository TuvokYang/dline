import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import ApiOptions from "../ApiOptions"

vi.mock("@/services/grpc-client", async (importOriginal) => {
    const actual = await importOriginal<Record<string, any>>()
    const noopFn = () => Promise.resolve({})
    const noopSubscribe = () => () => {}

    function proxyClient(name: string) {
        const base = actual[name] || {}
        return new Proxy(base, {
            get(target, prop) {
                if (typeof prop === "string" && prop in target) return Reflect.get(target, prop)
                if (typeof prop === "string" && prop.startsWith("subscribe")) return vi.fn(noopSubscribe)
                if (typeof prop === "string") return vi.fn(noopFn)
                return undefined
            },
        })
    }

    return {
        ...actual,
        FileServiceClient: proxyClient("FileServiceClient"),
        ModelsServiceClient: proxyClient("ModelsServiceClient"),
        StateServiceClient: proxyClient("StateServiceClient"),
        UiServiceClient: proxyClient("UiServiceClient"),
        AccountServiceClient: proxyClient("AccountServiceClient"),
    }
})

vi.mock("./providers/useApiProfiles", () => ({
    useApiProfiles: () => ({
        profiles: [],
        expandedId: null,
        setExpandedId: vi.fn(),
        editMode: false,
        setEditMode: vi.fn(),
        addProfile: vi.fn(),
        updateProfile: vi.fn(),
        removeProfile: vi.fn(),
        toggleEnabled: vi.fn(),
        toggleUsedFor: vi.fn(),
        toggleExpand: vi.fn(),
        selectProfile: vi.fn(),
        providerOptions: [],
        loaded: true,
    }),
}))

describe("ApiOptions Component", () => {
    it("renders API Provider selector input", () => {
        //@ts-expect-error - vscode mock
        global.vscode = { postMessage: vi.fn() }
        render(
            <ExtensionStateContextProvider>
                <ApiOptions currentMode="plan" showModelOptions={true} />
            </ExtensionStateContextProvider>,
        )
        // Provider selector uses data-testid="provider-selector-input"
        expect(screen.getByTestId("provider-selector-input")).toBeInTheDocument()
    })
})
