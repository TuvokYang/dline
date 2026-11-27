import GitHubIcon from "@/assets/GitHubIcon"
import XIcon from "@/assets/XIcon"
import { DLINE_REPOSITORY_URL } from "@/config/source-links"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

const LINK_CLASS =
    "inline-flex rounded-xs p-1.5 text-foreground hover:text-link-hover focus-visible:outline-2 focus-visible:outline-focus-border transition-colors"

export default function SocialLinks({ githubLabel }: { githubLabel?: string }) {
    const { t } = useUiTranslation()
    const repositoryLabel = githubLabel ?? t("shell.social.github")
    const accountLabel = t("shell.social.x")

    return (
        <nav aria-label={t("shell.social.links")} className="flex items-center justify-center gap-4 mt-2">
            <a
                aria-label={repositoryLabel}
                className={LINK_CLASS}
                href={DLINE_REPOSITORY_URL}
                rel="noopener noreferrer"
                target="_blank"
                title={repositoryLabel}>
                <span aria-hidden="true">
                    <GitHubIcon />
                </span>
            </a>
            <a
                aria-label={accountLabel}
                className={LINK_CLASS}
                href="https://x.com/DlineMOfficial"
                rel="noopener noreferrer"
                target="_blank"
                title={accountLabel}>
                <span aria-hidden="true">
                    <XIcon />
                </span>
            </a>
        </nav>
    )
}
