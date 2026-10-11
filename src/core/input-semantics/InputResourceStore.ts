import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { formatAttachmentLimit, maxAttachmentBytes } from "@shared/attachments"
import { type InputResourceOwner, type SemanticResourceRef, sameInputResourceOwner } from "@shared/input-semantics/document"
import { renameWithRetry, writeJsonAtomic } from "@shared/storage/atomic-file"
import {
    classifyInputFile,
    classifyPastedText,
    INPUT_RESOURCE_KINDS,
    type InputResourceClassification,
    type InputResourceKind,
} from "./InputResourceClassifier"
import {
    errnoOf,
    type InputResourceFailure,
    type InputResourceFailureCode,
    type InputResourceResult,
    resourceFailed,
    resourceSucceeded,
} from "./InputResourceFailure"

export const INPUT_RESOURCE_RECORD_SCHEMA_VERSION = 1
/** Name of the record inside each resource directory; its presence marks a committed resource. */
export const INPUT_RESOURCE_RECORD_FILE = "input-resource.json"

const FIRST_GENERATION = 1
const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/
const TEXT_EXTENSION_PATTERN = /^[A-Za-z0-9]{1,16}$/
const DEFAULT_TEXT_EXTENSION = "txt"
const DEFAULT_DISPLAY_NAME = "attachment"
const MAX_CONTENT_FILE_NAME_LENGTH = 120
const CONTENT_FILE_PREFIX = "content-"
/** Characters that are invalid in a file name on at least one supported platform. */
const UNSAFE_FILE_NAME_CHARACTERS: ReadonlySet<string> = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"])
const FIRST_PRINTABLE_CODE = 0x20
const DELETE_CODE = 0x7f
const RESERVED_WINDOWS_FILE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const PASTE_TIMESTAMP_SEPARATORS = /[-:.TZ]/g
const PASTE_SUFFIX_LENGTH = 8
const STAGING_SUFFIX = ".staging"
/** Resource content can be private source or documents, so only the owning user may read it. */
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

/**
 * Adoptions in flight per target owner. Adopting checks for an existing copy
 * before writing one, so two adoptions into the same owner must not interleave.
 */
const adoptionQueues = new Map<string, Promise<void>>()

/**
 * Where one owner keeps its input resources.
 *
 * The root decides where a resource directory lives and whether storage that
 * ages out must be kept alive; the store decides what a resource directory
 * contains. Roots never enumerate or interpret contents, so a new owner kind is
 * one more root, not another copy of the store.
 */
export interface InputResourceRoot {
    readonly owner: InputResourceOwner
    /** Absolute directory that holds exactly one resource; throws for an identity it cannot address. */
    resourceDirectory(resourceId: string): string
    /**
     * Called after a resource was verified, so a root whose storage ages out can
     * keep a resource that is still referenced. Roots tied to their owner's
     * lifetime omit it.
     */
    onVerifiedAccess?(resourceId: string): Promise<void>
}

/** The persisted authority for one input resource. */
export interface InputResourceRecord {
    readonly schemaVersion: typeof INPUT_RESOURCE_RECORD_SCHEMA_VERSION
    readonly resourceId: string
    readonly owner: InputResourceOwner
    /** Incremented whenever the resource is adopted into a new owner. */
    readonly generation: number
    readonly kind: InputResourceKind
    readonly mediaType: string
    /** Name shown to the user and the model. */
    readonly displayName: string
    /** Name of the content file inside the resource directory. */
    readonly fileName: string
    readonly byteLength: number
    readonly lineCount?: number
    readonly contentHash: string
}

/** A verified resource and the local copy only the Host may open. */
export interface ResolvedInputResource {
    readonly record: InputResourceRecord
    readonly contentPath: string
}

/** A verified resource together with the exact bytes that were verified. */
export interface LoadedInputResource {
    readonly record: InputResourceRecord
    readonly bytes: Buffer
}

export interface InputResourceAdoption {
    readonly record: InputResourceRecord
    /** True when an identical earlier adoption already existed and nothing was written. */
    readonly reused: boolean
}

export interface InputResourceRemoval {
    /** False when the resource did not exist or its files could not be deleted yet. */
    readonly removed: boolean
}

interface PendingResource {
    readonly resourceId: string
    readonly generation: number
    readonly displayName: string
    readonly classification: InputResourceClassification
    readonly bytes: Uint8Array
}

/** The reference a semantic input document carries for this record. */
export function referenceOf(record: InputResourceRecord): SemanticResourceRef {
    return {
        resourceId: record.resourceId,
        expectedContentHash: record.contentHash,
        mediaType: record.mediaType,
        byteLength: record.byteLength,
        owner: record.owner,
        generation: record.generation,
    }
}

/**
 * Owns the input resources of one owner and verifies every access.
 *
 * Each resource is a private directory holding its content file and record. It
 * is assembled under a staging name and published by one rename, so a resource
 * directory is either absent or complete and an interrupted write never takes
 * the identity. Abandoned staging directories are left to the root's cleanup.
 * A reference is
 * honored only when every claim it makes (identity, owner, generation, media
 * type, size and frozen hash) matches the record, the content still hashes to
 * the record, and no link redirects the files outside the owner's root. Any
 * mismatch fails closed with a sanitized failure instead of returning bytes.
 */
export class InputResourceStore {
    constructor(private readonly root: InputResourceRoot) {}

    get owner(): InputResourceOwner {
        return this.root.owner
    }

    /** Stage text the user pasted, named so an editor tab shows when it was pasted. */
    async stageText(
        text: string,
        options: { readonly extension?: string } = {},
    ): Promise<InputResourceResult<InputResourceRecord>> {
        const bytes = Buffer.from(text, "utf8")
        const classified = classifyPastedText(text, bytes.byteLength)
        if (!classified.ok) return classified

        const resourceId = randomUUID()
        return this.commit(
            {
                resourceId,
                generation: FIRST_GENERATION,
                displayName: pastedTextName(resourceId, options.extension),
                classification: classified.value,
                bytes,
            },
            "semantic_input_resource_stage_failed",
        )
    }

    /**
     * Stage a file that arrived as bytes. The name may come from another
     * platform, so both separators are treated as path separators.
     */
    async stageBytes(fileName: string, bytes: Uint8Array): Promise<InputResourceResult<InputResourceRecord>> {
        return this.stageNamedBytes(inputResourceDisplayName(fileName), bytes)
    }

    /** Stage a copy of a local file, so later edits of the source cannot change the input. */
    async stageFile(sourcePath: string): Promise<InputResourceResult<InputResourceRecord>> {
        const displayName = displayNameOf(path.basename(sourcePath))
        let size: number
        try {
            const stats = await fs.stat(sourcePath)
            if (!stats.isFile()) return resourceFailed("semantic_input_resource_invalid", `${displayName} is not a file`)
            size = stats.size
        } catch (error) {
            return sourceReadFailure(displayName, error)
        }
        // Checked before reading so an oversized file is never loaded into memory.
        if (size > maxAttachmentBytes(displayName)) {
            return resourceFailed(
                "semantic_input_resource_too_large",
                `${displayName} exceeds the ${formatAttachmentLimit(displayName)} attachment limit`,
            )
        }

        let bytes: Buffer
        try {
            bytes = await fs.readFile(sourcePath)
        } catch (error) {
            return sourceReadFailure(displayName, error)
        }
        return this.stageNamedBytes(displayName, bytes)
    }

    /** Verify a reference and return the local copy the Host may open. */
    async resolve(ref: SemanticResourceRef): Promise<InputResourceResult<ResolvedInputResource>> {
        const loaded = await this.load(ref)
        if (!loaded.ok) return loaded
        return resourceSucceeded({ record: loaded.value.record, contentPath: loaded.value.contentPath })
    }

    /** Verify a reference and return exactly the bytes that were verified. */
    async readBytes(ref: SemanticResourceRef): Promise<InputResourceResult<LoadedInputResource>> {
        const loaded = await this.load(ref)
        if (!loaded.ok) return loaded
        return resourceSucceeded({ record: loaded.value.record, bytes: loaded.value.bytes })
    }

    /**
     * Remove one of this owner's resources.
     *
     * Removal is idempotent. Only a directory that is verifiably this owner's
     * resource at its own location is deleted: a redirected directory or a
     * resource another owner holds in a shared root is refused. Files that
     * cannot be deleted yet are left to the root's cleanup, because nothing
     * references a removed resource.
     */
    async remove(resourceId: string): Promise<InputResourceResult<InputResourceRemoval>> {
        if (!isResourceId(resourceId)) return invalidIdentity()
        const addressed = this.directoryOf(resourceId)
        if (!addressed.ok) return addressed
        const directory = addressed.value
        const notRemoved = resourceSucceeded<InputResourceRemoval>({ removed: false })

        const located = await verifyResourceDirectory(directory, resourceId)
        if (!located.ok) return isMissing(located.failure) ? notRemoved : located
        const contained = await isDirectChild(located.value, path.join(directory, INPUT_RESOURCE_RECORD_FILE))
        if (!contained.ok) return isMissing(contained.failure) ? notRemoved : contained
        const stored = await readRecord(directory, resourceId)
        if (!stored.ok) return isMissing(stored.failure) ? notRemoved : stored
        if (stored.value.resourceId !== resourceId || !sameInputResourceOwner(stored.value.owner, this.root.owner)) {
            return resourceFailed(
                "semantic_input_resource_invalid",
                `resource ${resourceId} belongs to another owner`,
                resourceId,
            )
        }
        try {
            await fs.rm(directory, { recursive: true, force: true })
            return resourceSucceeded({ removed: true })
        } catch {
            return resourceSucceeded({ removed: false })
        }
    }

    /**
     * Copy a verified resource from another owner into this one.
     *
     * The copy keeps the resource identity and advances its generation, so a
     * document that referenced the source can be rebound by changing only owner
     * and generation. An identical earlier adoption is reused, which makes a
     * retried hand-off idempotent; the source is never modified or removed.
     */
    async adoptFrom(source: InputResourceStore, ref: SemanticResourceRef): Promise<InputResourceResult<InputResourceAdoption>> {
        return serializeByOwner(this.root.owner, () => this.adoptOne(source, ref))
    }

    /**
     * Adopt every reference or none of them.
     *
     * On the first failure the copies this call created are removed again;
     * reused copies predate the call and stay. When a created copy cannot be
     * removed the failure says so, because the target then holds an orphan.
     */
    async adoptAll(
        source: InputResourceStore,
        refs: readonly SemanticResourceRef[],
    ): Promise<InputResourceResult<readonly InputResourceAdoption[]>> {
        return serializeByOwner(this.root.owner, async () => {
            const adoptions: InputResourceAdoption[] = []
            for (const ref of refs) {
                const adopted = await this.adoptOne(source, ref)
                if (adopted.ok) {
                    adoptions.push(adopted.value)
                    continue
                }
                if (await this.rollBack(adoptions)) return adopted
                return resourceFailed(
                    "semantic_input_resource_adopt_failed",
                    `adopting resource ${ref.resourceId} failed and earlier copies could not be removed`,
                    ref.resourceId,
                )
            }
            return resourceSucceeded<readonly InputResourceAdoption[]>(adoptions)
        })
    }

    private async adoptOne(
        source: InputResourceStore,
        ref: SemanticResourceRef,
    ): Promise<InputResourceResult<InputResourceAdoption>> {
        const loaded = await source.load(ref)
        if (!loaded.ok) return loaded
        const { record: sourceRecord, bytes } = loaded.value
        const target = { ...referenceOf(sourceRecord), owner: this.root.owner, generation: sourceRecord.generation + 1 }

        const existing = await this.load(target)
        if (existing.ok) return resourceSucceeded({ record: existing.value.record, reused: true })
        if (existing.failure.code !== "semantic_input_resource_missing") {
            return resourceFailed(
                "semantic_input_resource_adopt_failed",
                `resource ${sourceRecord.resourceId} already exists here with different content`,
                sourceRecord.resourceId,
            )
        }

        const committed = await this.commit(
            {
                resourceId: sourceRecord.resourceId,
                generation: target.generation,
                displayName: sourceRecord.displayName,
                classification: classificationOf(sourceRecord),
                bytes,
            },
            "semantic_input_resource_adopt_failed",
        )
        if (!committed.ok) {
            // Another window may have published the same copy first; that copy is as good as ours.
            const concurrent = await this.load(target)
            return concurrent.ok ? resourceSucceeded({ record: concurrent.value.record, reused: true }) : committed
        }

        // Read the copy back so an adoption that reports success is verifiably intact.
        const verified = await this.load(referenceOf(committed.value))
        if (!verified.ok) {
            await this.remove(sourceRecord.resourceId)
            return resourceFailed(
                "semantic_input_resource_adopt_failed",
                `resource ${sourceRecord.resourceId} could not be verified after adoption`,
                sourceRecord.resourceId,
            )
        }
        return resourceSucceeded({ record: committed.value, reused: false })
    }

    /** Remove the copies an adoption created; true when none is left behind. */
    private async rollBack(adoptions: readonly InputResourceAdoption[]): Promise<boolean> {
        let complete = true
        for (const adoption of adoptions) {
            if (adoption.reused) continue
            const removed = await this.remove(adoption.record.resourceId)
            if (!removed.ok || !removed.value.removed) complete = false
        }
        return complete
    }

    /** The root's directory for a resource, as a failure when the root cannot address the identity. */
    private directoryOf(resourceId: string): InputResourceResult<string> {
        try {
            return resourceSucceeded(this.root.resourceDirectory(resourceId))
        } catch {
            return resourceFailed(
                "semantic_input_resource_invalid",
                `resource ${resourceId} cannot be addressed by this ${this.root.owner.kind}`,
                resourceId,
            )
        }
    }

    private async stageNamedBytes(displayName: string, bytes: Uint8Array): Promise<InputResourceResult<InputResourceRecord>> {
        const classified = await classifyInputFile(displayName, bytes)
        if (!classified.ok) return classified
        return this.commit(
            { resourceId: randomUUID(), generation: FIRST_GENERATION, displayName, classification: classified.value, bytes },
            "semantic_input_resource_stage_failed",
        )
    }

    /** Assemble the resource under a private staging name, then publish it with one rename. */
    private async commit(
        pending: PendingResource,
        failureCode: InputResourceFailureCode,
    ): Promise<InputResourceResult<InputResourceRecord>> {
        const { resourceId } = pending
        const addressed = this.directoryOf(resourceId)
        if (!addressed.ok) return addressed
        const directory = addressed.value
        const staging = `${directory}.${randomUUID()}${STAGING_SUFFIX}`

        const record: InputResourceRecord = {
            schemaVersion: INPUT_RESOURCE_RECORD_SCHEMA_VERSION,
            resourceId,
            owner: this.root.owner,
            generation: pending.generation,
            kind: pending.classification.kind,
            mediaType: pending.classification.mediaType,
            displayName: pending.displayName,
            fileName: contentFileNameOf(pending.displayName),
            byteLength: pending.bytes.byteLength,
            ...(pending.classification.lineCount === undefined ? {} : { lineCount: pending.classification.lineCount }),
            contentHash: sha256(pending.bytes),
        }
        try {
            await fs.mkdir(path.dirname(directory), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
            await fs.mkdir(staging, { mode: PRIVATE_DIRECTORY_MODE })
            await fs.writeFile(path.join(staging, record.fileName), pending.bytes, { flag: "wx", mode: PRIVATE_FILE_MODE })
            await writeJsonAtomic(path.join(staging, INPUT_RESOURCE_RECORD_FILE), record, { mode: PRIVATE_FILE_MODE })
            // A published resource directory is never empty, so the rename cannot replace one.
            await renameWithRetry(staging, directory)
            return resourceSucceeded(record)
        } catch (error) {
            await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
            return resourceFailed(failureCode, `could not store resource ${resourceId} (${errnoOf(error)})`, resourceId)
        }
    }

    /** Verify every claim of a reference, then the files, then the content itself. */
    private async load(
        ref: SemanticResourceRef,
    ): Promise<InputResourceResult<ResolvedInputResource & { readonly bytes: Buffer }>> {
        const resourceId = ref.resourceId
        if (!isResourceId(resourceId)) return invalidIdentity()
        if (!sameInputResourceOwner(ref.owner, this.root.owner)) {
            return resourceFailed(
                "semantic_input_resource_invalid",
                `resource ${resourceId} is not owned by this ${this.root.owner.kind}`,
                resourceId,
            )
        }

        const addressed = this.directoryOf(resourceId)
        if (!addressed.ok) return addressed
        const directory = addressed.value
        const located = await verifyResourceDirectory(directory, resourceId)
        if (!located.ok) return located
        const realDirectory = located.value

        const stored = await readRecord(directory, resourceId)
        if (!stored.ok) return stored
        const record = stored.value
        const claimMismatch = claimMismatchOf(ref, record, this.root.owner)
        if (claimMismatch) return claimMismatch

        if (!isPlainFileName(record.fileName)) {
            return resourceFailed(
                "semantic_input_resource_invalid",
                `resource ${resourceId} record names an unsafe content file`,
                resourceId,
            )
        }
        const contentPath = path.join(directory, record.fileName)
        for (const file of [path.join(directory, INPUT_RESOURCE_RECORD_FILE), contentPath]) {
            const contained = await isDirectChild(realDirectory, file)
            if (!contained.ok) return contained
        }

        let bytes: Buffer
        try {
            bytes = await fs.readFile(contentPath)
        } catch (error) {
            return errnoOf(error) === "ENOENT"
                ? resourceFailed("semantic_input_resource_missing", `resource ${resourceId} content no longer exists`, resourceId)
                : resourceFailed(
                      "semantic_input_resource_invalid",
                      `resource ${resourceId} content cannot be read (${errnoOf(error)})`,
                      resourceId,
                  )
        }
        if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.contentHash) {
            return resourceFailed(
                "semantic_input_resource_changed",
                `resource ${resourceId} content no longer matches its frozen hash`,
                resourceId,
            )
        }

        await this.root.onVerifiedAccess?.(resourceId).catch(() => undefined)
        return resourceSucceeded({ record, contentPath, bytes })
    }
}

/** The first claim a reference makes that its record contradicts, if any. */
function claimMismatchOf(
    ref: SemanticResourceRef,
    record: InputResourceRecord,
    owner: InputResourceOwner,
): InputResourceResult<never> | undefined {
    const resourceId = ref.resourceId
    if (record.resourceId !== resourceId || !sameInputResourceOwner(record.owner, owner)) {
        return resourceFailed(
            "semantic_input_resource_invalid",
            `resource ${resourceId} record does not match its location`,
            resourceId,
        )
    }
    if (record.generation !== ref.generation) {
        return resourceFailed(
            "semantic_input_resource_invalid",
            `resource ${resourceId} reference names generation ${ref.generation}, the store holds generation ${record.generation}`,
            resourceId,
        )
    }
    if (record.mediaType !== ref.mediaType) {
        return resourceFailed(
            "semantic_input_resource_invalid_mime",
            `resource ${resourceId} is not of the media type its reference claims`,
            resourceId,
        )
    }
    if (record.byteLength !== ref.byteLength) {
        return resourceFailed(
            "semantic_input_resource_invalid",
            `resource ${resourceId} is not of the size its reference claims`,
            resourceId,
        )
    }
    if (record.contentHash !== ref.expectedContentHash) {
        return resourceFailed(
            "semantic_input_resource_changed",
            `resource ${resourceId} is not the content this input was confirmed with`,
            resourceId,
        )
    }
    return undefined
}

/**
 * Resolve the real resource directory and require it to be the directory the
 * root names, so a link cannot redirect a resource outside its root.
 */
async function verifyResourceDirectory(directory: string, resourceId: string): Promise<InputResourceResult<string>> {
    try {
        const realDirectory = await fs.realpath(directory)
        const expected = path.join(await fs.realpath(path.dirname(directory)), path.basename(directory))
        return samePath(realDirectory, expected)
            ? resourceSucceeded(realDirectory)
            : resourceFailed(
                  "semantic_input_resource_invalid",
                  `resource ${resourceId} is redirected outside its storage`,
                  resourceId,
              )
    } catch (error) {
        return errnoOf(error) === "ENOENT"
            ? resourceFailed("semantic_input_resource_missing", `resource ${resourceId} does not exist`, resourceId)
            : resourceFailed(
                  "semantic_input_resource_invalid",
                  `resource ${resourceId} cannot be located (${errnoOf(error)})`,
                  resourceId,
              )
    }
}

async function isDirectChild(realDirectory: string, file: string): Promise<InputResourceResult<true>> {
    const resourceId = path.basename(realDirectory)
    try {
        const realFile = await fs.realpath(file)
        return samePath(path.dirname(realFile), realDirectory)
            ? resourceSucceeded(true)
            : resourceFailed(
                  "semantic_input_resource_invalid",
                  `resource ${resourceId} file is redirected outside its storage`,
                  resourceId,
              )
    } catch (error) {
        return errnoOf(error) === "ENOENT"
            ? resourceFailed("semantic_input_resource_missing", `resource ${resourceId} content no longer exists`, resourceId)
            : resourceFailed(
                  "semantic_input_resource_invalid",
                  `resource ${resourceId} file cannot be located (${errnoOf(error)})`,
                  resourceId,
              )
    }
}

/** Read the record strictly: one file and no fallback, so only a committed record is ever honored. */
async function readRecord(directory: string, resourceId: string): Promise<InputResourceResult<InputResourceRecord>> {
    let text: string
    try {
        text = await fs.readFile(path.join(directory, INPUT_RESOURCE_RECORD_FILE), "utf8")
    } catch (error) {
        return errnoOf(error) === "ENOENT"
            ? resourceFailed("semantic_input_resource_missing", `resource ${resourceId} does not exist`, resourceId)
            : resourceFailed(
                  "semantic_input_resource_invalid",
                  `resource ${resourceId} record cannot be read (${errnoOf(error)})`,
                  resourceId,
              )
    }
    try {
        return resourceSucceeded(parseRecord(JSON.parse(text)))
    } catch {
        return resourceFailed("semantic_input_resource_invalid", `resource ${resourceId} record is unreadable`, resourceId)
    }
}

function parseRecord(value: unknown): InputResourceRecord {
    if (!isObject(value)) throw new Error("input resource record is not an object")
    const owner = parseOwner(value.owner)
    const { resourceId, kind, mediaType, displayName, fileName, contentHash, generation, byteLength, lineCount } = value
    if (value.schemaVersion !== INPUT_RESOURCE_RECORD_SCHEMA_VERSION) throw new Error("unsupported input resource record version")
    if (typeof resourceId !== "string" || !isResourceId(resourceId)) throw new Error("invalid resource id")
    if (typeof kind !== "string" || !INPUT_RESOURCE_KINDS.includes(kind as InputResourceKind)) throw new Error("invalid kind")
    if (typeof mediaType !== "string" || !mediaType) throw new Error("invalid media type")
    if (typeof displayName !== "string" || !displayName) throw new Error("invalid display name")
    if (typeof fileName !== "string" || !fileName) throw new Error("invalid file name")
    if (typeof contentHash !== "string" || !CONTENT_HASH_PATTERN.test(contentHash)) throw new Error("invalid content hash")
    if (!isCount(generation) || generation < FIRST_GENERATION) throw new Error("invalid generation")
    if (!isCount(byteLength)) throw new Error("invalid byte length")
    if (lineCount !== undefined && !isCount(lineCount)) throw new Error("invalid line count")
    return {
        schemaVersion: INPUT_RESOURCE_RECORD_SCHEMA_VERSION,
        resourceId,
        owner,
        generation,
        kind: kind as InputResourceKind,
        mediaType,
        displayName,
        fileName,
        byteLength,
        ...(lineCount === undefined ? {} : { lineCount }),
        contentHash,
    }
}

function parseOwner(value: unknown): InputResourceOwner {
    if (isObject(value) && value.kind === "draft" && typeof value.draftId === "string" && value.draftId) {
        return { kind: "draft", draftId: value.draftId }
    }
    if (isObject(value) && value.kind === "task" && typeof value.taskId === "string" && value.taskId) {
        return { kind: "task", taskId: value.taskId }
    }
    throw new Error("invalid owner")
}

function classificationOf(record: InputResourceRecord): InputResourceClassification {
    return {
        kind: record.kind,
        mediaType: record.mediaType,
        ...(record.lineCount === undefined ? {} : { lineCount: record.lineCount }),
    }
}

function sourceReadFailure(displayName: string, error: unknown): InputResourceResult<never> {
    return errnoOf(error) === "ENOENT"
        ? resourceFailed("semantic_input_resource_missing", `${displayName} no longer exists`)
        : resourceFailed("semantic_input_resource_stage_failed", `could not read ${displayName} (${errnoOf(error)})`)
}

function invalidIdentity(): InputResourceResult<never> {
    return resourceFailed("semantic_input_resource_invalid", "resource reference does not carry a store-issued identity")
}

function isResourceId(value: string): boolean {
    return RESOURCE_ID_PATTERN.test(value)
}

function isMissing(failure: InputResourceFailure): boolean {
    return failure.code === "semantic_input_resource_missing"
}

/** Run work after every earlier adoption into the same owner has settled. */
function serializeByOwner<T>(owner: InputResourceOwner, work: () => Promise<T>): Promise<T> {
    const key = owner.kind === "draft" ? `draft:${owner.draftId}` : `task:${owner.taskId}`
    const run = (adoptionQueues.get(key) ?? Promise.resolve()).then(work)
    const settled = run.then(
        () => undefined,
        () => undefined,
    )
    adoptionQueues.set(key, settled)
    void settled.then(() => {
        if (adoptionQueues.get(key) === settled) adoptionQueues.delete(key)
    })
    return run
}

/**
 * The name a resource shows for a file name from any platform: its leaf, with
 * either separator treated as a path separator, without control characters.
 */
export function inputResourceDisplayName(fileName: string): string {
    return displayNameOf(path.win32.basename(fileName))
}

/** User-visible name: the leaf name without control characters. */
function displayNameOf(leafName: string): string {
    const printable = Array.from(leafName)
        .filter((character) => !isControlCharacter(character))
        .join("")
    return printable.trim() || DEFAULT_DISPLAY_NAME
}

function isControlCharacter(character: string): boolean {
    const code = character.charCodeAt(0)
    return code < FIRST_PRINTABLE_CODE || code === DELETE_CODE
}

/**
 * Name of the content file: the display name made safe on every platform, and
 * never the record's own name, so content and record cannot collide.
 */
function contentFileNameOf(displayName: string): string {
    let name = Array.from(displayName, (character) =>
        UNSAFE_FILE_NAME_CHARACTERS.has(character) || isControlCharacter(character) ? "_" : character,
    )
        .join("")
        .replace(/[. ]+$/, "")
        .trim()
    if (!name || name === "." || name === "..") name = DEFAULT_DISPLAY_NAME
    if (name.length > MAX_CONTENT_FILE_NAME_LENGTH) {
        const extension = path.extname(name).slice(0, 17)
        name = `${name.slice(0, MAX_CONTENT_FILE_NAME_LENGTH - extension.length)}${extension}`
    }
    if (RESERVED_WINDOWS_FILE_NAME.test(name) || name.toLowerCase() === INPUT_RESOURCE_RECORD_FILE) {
        name = `${CONTENT_FILE_PREFIX}${name}`
    }
    return name
}

/** A leaf name on every platform, so it cannot address a sibling or parent. */
function isPlainFileName(name: string): boolean {
    return (
        name !== "." &&
        name !== ".." &&
        name !== INPUT_RESOURCE_RECORD_FILE &&
        !name.includes("\0") &&
        path.posix.basename(name) === name &&
        path.win32.basename(name) === name
    )
}

/**
 * A readable, collision-free name for pasted text. The timestamp makes the file
 * recognizable in an editor tab; the identity suffix keeps two pastes in the
 * same second apart.
 */
function pastedTextName(resourceId: string, extension: string | undefined): string {
    const timestamp = new Date().toISOString().replace(PASTE_TIMESTAMP_SEPARATORS, "").slice(0, 14)
    const suffix = resourceId.replace(/-/g, "").slice(0, PASTE_SUFFIX_LENGTH)
    const safeExtension = extension && TEXT_EXTENSION_PATTERN.test(extension) ? extension : DEFAULT_TEXT_EXTENSION
    return `input_${timestamp}_${suffix}.${safeExtension}`
}

function samePath(left: string, right: string): boolean {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex")
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
