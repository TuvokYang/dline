/**
 * Language-split changelog rendering for one VSIX.
 *
 * This module is a pure formatter. It receives notes that the shared reader has
 * already located, validated and localized, and it lays them out as one document
 * per language. It reads no file, resolves no path, parses no heading and owns no
 * fence, version or emptiness rule: those live in `changelog-parser.mjs` and are
 * applied by `changelog.mjs` for every consumer.
 *
 * The content section and the displayed version stay separate inputs. An entry
 * (`package-vsix.mjs`, `package-dev.mjs`, `e2e-package.mjs`) selects the section
 * from its channel, and the packaging adapter reads the displayed version from
 * the effective manifest.
 */

/** Content section of a build that has no released version yet. */
/** Anchor of one content section heading, re-exported for callers and tests. */
export { sectionAnchor, UNRELEASED_SECTION } from "./changelog-parser.mjs"

/** Title each generated document starts with. */
const CHANGELOG_TITLES = { english: "# Changelog", chinese: "# 更新日志" }

/** What a rolling build says in each language when nothing is recorded yet. */
export const EMPTY_NOTES = {
    english: "No changes are recorded for this build yet.",
    chinese: "此构建尚无已记录的新增变更。",
}

/**
 * One language document: title, online navigation, the one packaged version, body.
 *
 * @param {{ title: string, navigation: string, version: string, body: string }} parts
 * @returns {string}
 */
function renderDocument({ title, navigation, version, body }) {
    return `${[title, navigation, `## [${version}]`, body].join("\n\n")}\n`
}

/**
 * Render one document per language from already validated notes.
 *
 * Each document carries only its own language body, preceded by the title, the
 * navigation line, and the packaged version. Nothing else is copied from either
 * source: no page-top language switch, no `Unreleased` heading, no other version,
 * no language wrapper. An empty rolling section is stated per language instead of
 * borrowing a release, and the caller has already rejected a half-translated one.
 *
 * @param {{
 *   section: string,
 *   displayVersion: string,
 *   navigation: { english: string, chinese: string },
 *   notes: {
 *     english: { body: string, empty: boolean },
 *     chinese: { body: string, empty: boolean },
 *   },
 * }} input Content section, packaged version, online navigation lines and both validated bodies.
 * @returns {{ english: string, chinese: string }} The two generated documents.
 */
export function renderChangelogs({ section, displayVersion, navigation, notes }) {
    const contentSection = typeof section === "string" ? section.trim() : ""
    if (!contentSection) {
        throw new Error("A VSIX changelog needs an explicit content section; entries must select one.")
    }
    const version = typeof displayVersion === "string" ? displayVersion.trim() : ""
    if (!version) {
        throw new Error("A VSIX changelog needs the packaged manifest version to display.")
    }
    for (const language of ["english", "chinese"]) {
        const line = navigation?.[language]
        if (typeof line !== "string" || !line.trim()) {
            throw new Error(`A VSIX changelog needs the ${language} navigation line.`)
        }
    }
    if (!notes?.english || !notes?.chinese) {
        throw new Error("A VSIX changelog needs validated notes for both languages from the shared reader.")
    }

    return {
        english: renderDocument({
            title: CHANGELOG_TITLES.english,
            navigation: navigation.english,
            version,
            body: notes.english.empty ? EMPTY_NOTES.english : notes.english.body,
        }),
        chinese: renderDocument({
            title: CHANGELOG_TITLES.chinese,
            navigation: navigation.chinese,
            version,
            body: notes.chinese.empty ? EMPTY_NOTES.chinese : notes.chinese.body,
        }),
    }
}
