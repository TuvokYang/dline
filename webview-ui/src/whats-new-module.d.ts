// Virtual module served by webview-ui/vite-whats-new.ts.
declare module "virtual:dline-whats-new" {
    import type { WhatsNewRelease } from "@/config/whats-new-release"

    const release: WhatsNewRelease
    export default release
}
