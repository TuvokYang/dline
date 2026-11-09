import { localizedReleases } from "virtual:dline-whats-new"
import React from "react"
import { repositoryFileUrl } from "@/config/source-links"
import type { WhatsNewInline } from "@/config/whats-new-release"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { UiText } from "@/i18n/UiText"

interface WhatsNewItemsProps {
    inlineCodeStyle: React.CSSProperties
}

const LINK_STYLE: React.CSSProperties = { color: "var(--vscode-textLink-foreground)" }

function renderInline(run: WhatsNewInline, inlineCodeStyle: React.CSSProperties): React.ReactNode {
    switch (run.kind) {
        case "text":
            return run.text
        case "strong":
            return <strong>{run.text}</strong>
        case "code":
            return <code style={inlineCodeStyle}>{run.text}</code>
        case "link":
            return (
                <a href={run.href} rel="noopener noreferrer" style={LINK_STYLE} target="_blank">
                    {run.text}
                </a>
            )
    }
}

/**
 * Highlights of the newest release, parsed at build time from the paired
 * `docs/whats-new/WHATS_NEW_en.md` and `docs/whats-new/WHATS_NEW.md` editions.
 *
 * Both editions describe one release: the release version and its
 * acknowledgment boundary are identical, so only the presented items follow the
 * display language.
 */
export const WhatsNewItems: React.FC<WhatsNewItemsProps> = ({ inlineCodeStyle }) => {
    const { language, t } = useUiTranslation()
    const release = localizedReleases[language]
    const changelogUrl = repositoryFileUrl(language === "zh-CN" ? "CHANGELOG.md" : "docs/changelog/CHANGELOG_en.md")

    return (
        <div className="text-sm" style={{ color: "var(--vscode-descriptionForeground)" }}>
            <ul className="list-disc pl-5 space-y-2 m-0">
                {release.items.map((item, itemIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the list is a build-time constant and never reorders.
                    <li key={itemIndex}>
                        {item.map((run, runIndex) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: runs are a build-time constant and never reorder.
                            <React.Fragment key={runIndex}>{renderInline(run, inlineCodeStyle)}</React.Fragment>
                        ))}
                    </li>
                ))}
            </ul>
            <p className="mt-3 mb-0">
                <UiText
                    slots={{
                        link: (
                            <a href={changelogUrl} rel="noopener noreferrer" style={LINK_STYLE} target="_blank">
                                {t("shell.whatsNew.changelogLink")}
                            </a>
                        ),
                    }}
                    text={t("shell.whatsNew.changelog")}
                />
            </p>
        </div>
    )
}

export default WhatsNewItems
