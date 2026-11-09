// Virtual module served by webview-ui/vite-whats-new.ts.
declare module "virtual:dline-whats-new" {
    import type { WhatsNewEditions, WhatsNewRelease } from "@/config/whats-new-release"

    export const localizedReleases: WhatsNewEditions
    const release: WhatsNewRelease
    export default release
}
