import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const IDENTITY_PATH = path.join(__dirname, "..", "src", "shared", "extension-distributions.json")

export const STABLE_PACKAGE_NAME = "dline"
export const INSIDERS_PACKAGE_NAME = "dline-insiders"
/**
 * Package name published to the VS Code Marketplace.
 *
 * The Marketplace requires `name` to be unique across the whole registry,
 * ignoring publisher, so the publisher-specific build cannot reuse `dline`.
 * Open VSX keeps the stable `dline` identity because it keys extensions by
 * publisher and name.
 */
export const VSCODE_MARKETPLACE_PACKAGE_NAME = "dline-main"

/** Registry key that selects the VS Code Marketplace package identity. */
export const VSCODE_MARKETPLACE_REGISTRY = "vscode-marketplace"

/** Publisher account that owns the VS Code Marketplace package. */
export const VSCODE_MARKETPLACE_PUBLISHER = "tuvokyangdline"

const identities = JSON.parse(fs.readFileSync(IDENTITY_PATH, "utf-8"))

/** Return the explicit VS Code identity owned by one distribution package. */
export function getDistributionIdentity(packageName) {
    const identity = identities[packageName]
    if (!identity) {
        throw new Error(`No VS Code distribution identity is registered for '${packageName}'.`)
    }
    return identity
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value))
}

/**
 * Resolve the package identity one target publishes.
 *
 * Insiders is its own extension on every registry. Otherwise the VS Code
 * Marketplace takes a registry-wide unique name because it rejects a name
 * another publisher already owns, while Open VSX keys extensions by publisher
 * and name and keeps the stable identity. An explicit publisher wins so a
 * one-off package keeps its own target.
 *
 * @param {string} channel Target channel.
 * @param {string|null} registry Target registry.
 * @param {string} sourceName Stable package name from package.json.
 * @param {string} sourcePublisher Stable publisher from package.json.
 * @param {string|null} publisherOverride Explicit publisher override.
 * @returns {{packageName: string, publisher: string}} Identity to publish.
 */
export function resolveTargetIdentity(channel, registry, sourceName, sourcePublisher, publisherOverride = null) {
    const packageName =
        channel === "insiders"
            ? INSIDERS_PACKAGE_NAME
            : registry === VSCODE_MARKETPLACE_REGISTRY
              ? VSCODE_MARKETPLACE_PACKAGE_NAME
              : sourceName
    const publisher =
        publisherOverride ?? (registry === VSCODE_MARKETPLACE_REGISTRY ? VSCODE_MARKETPLACE_PUBLISHER : sourcePublisher)
    return { packageName, publisher }
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Replace only complete registered identifiers inside a VS Code when clause. */
function replaceRegisteredIdentifiers(expression, replacements) {
    if (typeof expression !== "string") return expression

    let result = expression
    const entries = [...replacements.entries()].sort(([left], [right]) => right.length - left.length)
    for (const [source, target] of entries) {
        const pattern = new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(source)}(?![A-Za-z0-9_.-])`, "g")
        result = result.replace(pattern, target)
    }
    return result
}

function renameOwnKey(record, source, target) {
    if (!record || !Object.hasOwn(record, source)) return
    const value = record[source]
    delete record[source]
    record[target] = value
}

function targetCommandId(commandId, sourceNamespace, targetNamespace) {
    const prefix = `${sourceNamespace}.`
    return commandId.startsWith(prefix) ? `${targetNamespace}.${commandId.slice(prefix.length)}` : commandId
}

/**
 * Project the stable source manifest into one distribution identity.
 *
 * The source package.json remains the stable public contract. Insiders receives
 * a structurally transformed manifest so every VS Code-global registration is
 * owned by its own extension instead of colliding with tuvokyang.dline.
 */
export function createDistributionManifest(sourceManifest, packageName, version, publisher = sourceManifest.publisher) {
    const source = getDistributionIdentity(STABLE_PACKAGE_NAME)
    const target = getDistributionIdentity(packageName)
    const manifest = cloneJson(sourceManifest)

    if (sourceManifest.name !== STABLE_PACKAGE_NAME) {
        throw new Error(`Expected the source manifest name '${STABLE_PACKAGE_NAME}', got '${sourceManifest.name}'.`)
    }
    if (!version) {
        throw new Error("A distribution version is required.")
    }

    manifest.name = target.packageName
    manifest.publisher = publisher
    manifest.displayName = target.displayName
    manifest.version = version
    if (target.preview) manifest.preview = true
    else delete manifest.preview

    // A distribution that keeps the stable contribution namespace shares every
    // VS Code-global registration with the stable build. Only the VSIX package
    // identity differs, so the contributions must stay untouched; rewriting them
    // here would drop the stable keybindings.
    if (target.contributionNamespace === source.contributionNamespace) {
        return manifest
    }

    const contributes = manifest.contributes
    if (!contributes) {
        throw new Error("The extension manifest has no contributes section.")
    }

    const replacements = new Map([
        [source.activityBarId, target.activityBarId],
        [source.sidebarViewId, target.sidebarViewId],
        [source.commentControllerId, target.commentControllerId],
        [source.productIconId, target.productIconId],
        ...Object.keys(source.contextKeys).map((key) => [source.contextKeys[key], target.contextKeys[key]]),
    ])

    const commandMap = new Map()
    for (const command of contributes.commands ?? []) {
        const mapped = targetCommandId(command.command, source.contributionNamespace, target.contributionNamespace)
        commandMap.set(command.command, mapped)
        command.command = mapped
        if (command.category === source.displayName) command.category = target.displayName
        if (command.icon === `$(${source.productIconId})`) command.icon = `$(${target.productIconId})`
        command.when = replaceRegisteredIdentifiers(command.when, replacements)
        command.enablement = replaceRegisteredIdentifiers(command.enablement, replacements)
    }

    for (const [sourceCommand, targetCommand] of commandMap) {
        replacements.set(sourceCommand, targetCommand)
    }

    const activityBar = contributes.viewsContainers?.activitybar
    if (!Array.isArray(activityBar)) {
        throw new Error("contributes.viewsContainers.activitybar must be an array.")
    }
    const container = activityBar.find((entry) => entry.id === source.activityBarId)
    if (!container) {
        throw new Error(`Activity Bar container '${source.activityBarId}' was not found.`)
    }
    container.id = target.activityBarId
    container.title = target.displayName

    renameOwnKey(contributes.views, source.activityBarId, target.activityBarId)
    const sidebarViews = contributes.views?.[target.activityBarId]
    if (!Array.isArray(sidebarViews)) {
        throw new Error(`Views for '${target.activityBarId}' were not found.`)
    }
    for (const view of sidebarViews) {
        if (view.id === source.sidebarViewId) view.id = target.sidebarViewId
    }

    renameOwnKey(contributes.icons, source.productIconId, target.productIconId)

    for (const entries of Object.values(contributes.menus ?? {})) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
            entry.command = commandMap.get(entry.command) ?? entry.command
            entry.when = replaceRegisteredIdentifiers(entry.when, replacements)
            entry.enablement = replaceRegisteredIdentifiers(entry.enablement, replacements)
        }
    }

    // Stable owns extension command shortcuts when both distributions are installed.
    // Preserve built-in bindings such as comment submission, whose when clause is
    // scoped to this distribution's independently named controller.
    const preservedKeybindings = (contributes.keybindings ?? [])
        .filter((entry) => !commandMap.has(entry.command))
        .map((entry) => ({
            ...entry,
            when: replaceRegisteredIdentifiers(entry.when, replacements),
        }))
    if (preservedKeybindings.length > 0) contributes.keybindings = preservedKeybindings
    else delete contributes.keybindings

    if (contributes.configuration?.title === source.displayName) {
        contributes.configuration.title = target.displayName
    }

    manifest.activationEvents = (manifest.activationEvents ?? []).map((event) => {
        if (!event.startsWith("onCommand:")) return event
        const command = event.slice("onCommand:".length)
        return `onCommand:${commandMap.get(command) ?? command}`
    })

    return manifest
}
