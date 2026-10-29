import { createHash } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ArtifactResolver } from "../ArtifactResolver"
import { ArtifactStoreError, TaskArtifactStore, type TaskArtifactStoreLimits } from "../TaskArtifactStore"

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
)

function createPng(width: number, height: number, suffix: number[] = []): Buffer {
    const bytes = Buffer.from(PNG_1X1)
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(height, 20)
    return Buffer.concat([bytes, Buffer.from(suffix)])
}

function createJpeg(width: number, height: number): Buffer {
    return Buffer.from([
        0xff,
        0xd8,
        0xff,
        0xe0,
        0x00,
        0x02,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        (height >>> 8) & 0xff,
        height & 0xff,
        (width >>> 8) & 0xff,
        width & 0xff,
        0x03,
        0x01,
        0x11,
        0x00,
        0x02,
        0x11,
        0x00,
        0x03,
        0x11,
        0x00,
        0xff,
        0xd9,
    ])
}

function createWebp(width: number, height: number): Buffer {
    const bytes = Buffer.alloc(30)
    bytes.write("RIFF", 0, "ascii")
    bytes.writeUInt32LE(22, 4)
    bytes.write("WEBP", 8, "ascii")
    bytes.write("VP8X", 12, "ascii")
    bytes.writeUInt32LE(10, 16)
    bytes.writeUIntLE(width - 1, 24, 3)
    bytes.writeUIntLE(height - 1, 27, 3)
    return bytes
}

async function expectArtifactError(promise: Promise<unknown>, code: ArtifactStoreError["code"]): Promise<void> {
    try {
        await promise
        throw new Error(`Expected ArtifactStoreError with code ${code}`)
    } catch (error) {
        expect(error).toBeInstanceOf(ArtifactStoreError)
        expect((error as ArtifactStoreError).code).toBe(code)
    }
}

describe("TaskArtifactStore", () => {
    let tempDirectory: string
    let taskDirectory: string

    beforeEach(async () => {
        tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-image-artifacts-"))
        taskDirectory = path.join(tempDirectory, "tasks", "task-1")
    })

    afterEach(async () => {
        await fs.rm(tempDirectory, { recursive: true, force: true })
    })

    function createStore(limits?: Partial<TaskArtifactStoreLimits>): TaskArtifactStore {
        return new TaskArtifactStore({
            taskId: "task-1",
            taskDirectory,
            limits,
            now: () => 1_234,
        })
    }

    it.each([
        { mimeType: "image/png", format: "png", bytes: createPng(1, 1), width: 1, height: 1 },
        { mimeType: "image/jpeg", format: "jpeg", bytes: createJpeg(3, 2), width: 3, height: 2 },
        { mimeType: "image/webp", format: "webp", bytes: createWebp(5, 4), width: 5, height: 4 },
    ] as const)("stores validated $format bytes with a stable content-addressed ID", async (fixture) => {
        const store = createStore()
        const expectedHash = createHash("sha256").update(fixture.bytes).digest("hex")

        const artifact = await store.storeImage({
            bytes: fixture.bytes,
            declaredMimeType: fixture.mimeType,
            provenance: {
                providerId: "fake",
                modelId: "fake-image",
                requestId: "request-1",
                providerOutputId: `output-${fixture.format}`,
            },
        })

        expect(artifact).toMatchObject({
            schemaVersion: 1,
            id: `image:sha256:${expectedHash}`,
            kind: "image",
            sha256: expectedHash,
            mimeType: fixture.mimeType,
            format: fixture.format,
            byteLength: fixture.bytes.byteLength,
            width: fixture.width,
            height: fixture.height,
            createdAtMs: 1_234,
        })
        expect(await fs.readFile(path.join(taskDirectory, "artifacts", artifact.relativePath))).toEqual(fixture.bytes)
        expect(
            (await fs.readdir(path.join(taskDirectory, "artifacts", "images"))).some(
                (name) => name.endsWith(".partial") || name.endsWith(".tmp"),
            ),
        ).toBe(false)
    })

    it("deduplicates identical content and recovers the versioned manifest after restart", async () => {
        const firstStore = createStore()
        const first = await firstStore.storeImage({ bytes: PNG_1X1, declaredMimeType: "image/png" })
        const duplicate = await firstStore.storeImage({ bytes: PNG_1X1, declaredMimeType: "image/png" })
        const recoveredStore = createStore()

        const recovered = await recoveredStore.getImage(first.id)
        const listed = await recoveredStore.listImages()
        const imageFiles = await fs.readdir(path.join(taskDirectory, "artifacts", "images"))
        const manifest = JSON.parse(await fs.readFile(path.join(taskDirectory, "artifacts", "manifest.json"), "utf8"))

        expect(duplicate).toEqual(first)
        expect(recovered).toEqual(first)
        expect(listed).toEqual([first])
        expect(imageFiles).toEqual([`${first.sha256}.png`])
        expect(manifest).toMatchObject({ schemaVersion: 1, taskId: "task-1", artifacts: [first] })
    })

    it("commits a provider request atomically when a later image is invalid", async () => {
        const store = createStore()
        const resolver = new ArtifactResolver(store)

        await expectArtifactError(
            resolver.persistProviderOutputs(
                [
                    { id: "valid-first", source: { kind: "bytes", bytes: PNG_1X1, mimeType: "image/png" } },
                    { id: "invalid-second", source: { kind: "bytes", bytes: PNG_1X1, mimeType: "image/jpeg" } },
                ],
                { providerId: "fake", modelId: "fake-image", requestId: "request-atomic" },
            ),
            "mime_type_mismatch",
        )

        expect(await store.listImages()).toEqual([])
        expect(await fs.readdir(path.join(taskDirectory, "artifacts", "images"))).toEqual([])
        await expect(fs.readFile(path.join(taskDirectory, "artifacts", "manifest.json"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        })
    })

    it("normalizes raw bytes and HTTPS URL outputs through the same artifact boundary", async () => {
        const store = createStore()
        let downloadCount = 0
        const downloadedBytes = createPng(1, 1, [7])
        const resolver = new ArtifactResolver(store, {
            urlDownloader: {
                download: async ({ url, maxBytes }) => {
                    downloadCount++
                    expect(url.href).toBe("https://images.example.test/generated.png")
                    expect(maxBytes).toBeGreaterThanOrEqual(downloadedBytes.byteLength)
                    return { bytes: downloadedBytes, mimeType: "image/png" }
                },
            },
        })

        const bytesArtifact = await resolver.persistProviderOutput(
            {
                id: "provider-output-bytes",
                source: { kind: "bytes", bytes: PNG_1X1, mimeType: "image/png" },
            },
            { providerId: "fake", modelId: "fake-image", requestId: "request-1" },
        )
        const urlArtifact = await resolver.persistProviderOutput(
            {
                id: "provider-output-url",
                source: { kind: "url", url: "https://images.example.test/generated.png" },
            },
            { providerId: "fake", modelId: "fake-image", requestId: "request-1" },
        )

        expect(Buffer.from((await resolver.resolveImage(bytesArtifact.id)).bytes)).toEqual(PNG_1X1)
        expect(Buffer.from((await resolver.resolveImage(urlArtifact.id)).bytes)).toEqual(downloadedBytes)
        expect(downloadCount).toBe(1)
        await expectArtifactError(
            resolver.persistProviderOutput(
                {
                    id: "provider-output-http",
                    source: { kind: "url", url: "http://127.0.0.1/generated.png" },
                },
                { providerId: "fake", modelId: "fake-image", requestId: "request-1" },
            ),
            "unsafe_artifact_url",
        )
        expect(downloadCount).toBe(1)
    })

    it("normalizes strict base64 output without persisting the encoded payload", async () => {
        const store = createStore()
        const resolver = new ArtifactResolver(store)
        const encoded = PNG_1X1.toString("base64")

        const artifact = await resolver.persistProviderOutput(
            {
                id: "provider-output-1",
                source: { kind: "base64", data: encoded, mimeType: "image/png" },
            },
            { providerId: "fake", modelId: "fake-image", requestId: "request-1" },
        )
        const manifestText = await fs.readFile(path.join(taskDirectory, "artifacts", "manifest.json"), "utf8")

        expect(Buffer.from((await resolver.resolveImage(artifact.id)).bytes)).toEqual(PNG_1X1)
        expect(manifestText).not.toContain(encoded)
        await expectArtifactError(
            resolver.persistProviderOutput(
                {
                    id: "provider-output-2",
                    source: { kind: "base64", data: "not valid base64!", mimeType: "image/png" },
                },
                { providerId: "fake", modelId: "fake-image", requestId: "request-1" },
            ),
            "invalid_base64",
        )
    })

    it("rejects MIME mismatches, SVG, and unknown bytes without registering partial artifacts", async () => {
        const store = createStore()

        await expectArtifactError(store.storeImage({ bytes: PNG_1X1, declaredMimeType: "image/jpeg" }), "mime_type_mismatch")
        await expectArtifactError(
            store.storeImage({
                bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
                declaredMimeType: "image/svg+xml",
            }),
            "unsupported_format",
        )
        await expectArtifactError(
            store.storeImage({ bytes: Buffer.from("not an image"), declaredMimeType: "image/png" }),
            "unsupported_format",
        )

        expect(await store.listImages()).toEqual([])
        const artifactRootEntries = await fs.readdir(path.join(taskDirectory, "artifacts"), { withFileTypes: true })
        expect(artifactRootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([])
        expect(await fs.readdir(path.join(taskDirectory, "artifacts", "images"))).toEqual([])
    })

    it("enforces per-file and task byte quotas before registering artifacts", async () => {
        const fileLimitedStore = createStore({ maxArtifactBytes: PNG_1X1.byteLength - 1 })
        await expectArtifactError(
            fileLimitedStore.storeImage({ bytes: PNG_1X1, declaredMimeType: "image/png" }),
            "artifact_size_exceeded",
        )
        expect(await fileLimitedStore.listImages()).toEqual([])

        const firstBytes = createPng(1, 1, [1])
        const secondBytes = createPng(1, 1, [2])
        const taskLimitedStore = createStore({ maxTaskBytes: firstBytes.byteLength + secondBytes.byteLength - 1 })
        await taskLimitedStore.storeImage({ bytes: firstBytes, declaredMimeType: "image/png" })
        await expectArtifactError(
            taskLimitedStore.storeImage({ bytes: secondBytes, declaredMimeType: "image/png" }),
            "task_quota_exceeded",
        )
        expect(await taskLimitedStore.listImages()).toHaveLength(1)
    })

    it("rejects dimensions and pixel counts that exceed the configured limits", async () => {
        const dimensionLimitedStore = createStore({ maxWidth: 4, maxHeight: 4, maxPixels: 16 })
        await expectArtifactError(
            dimensionLimitedStore.storeImage({ bytes: createPng(5, 1), declaredMimeType: "image/png" }),
            "image_dimensions_exceeded",
        )

        const pixelLimitedStore = createStore({ maxWidth: 10, maxHeight: 10, maxPixels: 20 })
        await expectArtifactError(
            pixelLimitedStore.storeImage({ bytes: createPng(5, 5), declaredMimeType: "image/png" }),
            "image_pixels_exceeded",
        )
    })

    it("persists canonical parent provenance and returns defensive copies", async () => {
        const store = createStore()
        const parentArtifactId = `image:sha256:${"b".repeat(64)}`
        const parentArtifactIds = [parentArtifactId]
        const artifact = await store.storeImage({
            bytes: PNG_1X1,
            declaredMimeType: "image/png",
            provenance: { providerId: "openai", parentArtifactIds },
        })

        parentArtifactIds.length = 0
        expect(artifact.provenance?.parentArtifactIds).toEqual([parentArtifactId])
        artifact.provenance?.parentArtifactIds?.push(`image:sha256:${"c".repeat(64)}`)
        expect((await store.getImage(artifact.id)).provenance?.parentArtifactIds).toEqual([parentArtifactId])

        await expectArtifactError(
            store.storeImage({
                bytes: createPng(1, 1, [9]),
                declaredMimeType: "image/png",
                provenance: { parentArtifactIds: ["image:sha256:not-canonical"] },
            }),
            "invalid_manifest",
        )
    })

    it("fails closed for invalid artifact IDs and detects persisted file tampering", async () => {
        const store = createStore()
        const resolver = new ArtifactResolver(store)
        const artifact = await store.storeImage({ bytes: PNG_1X1, declaredMimeType: "image/png" })

        await expectArtifactError(resolver.resolveImage("../manifest.json"), "invalid_artifact_id")
        await expectArtifactError(resolver.resolveImage("image:sha256:not-a-hash"), "invalid_artifact_id")

        await fs.writeFile(path.join(taskDirectory, "artifacts", artifact.relativePath), createPng(1, 1, [9]))
        await expectArtifactError(resolver.resolveImage(artifact.id), "artifact_integrity_failed")
    })

    it("rejects unsupported manifest versions and removes stale partial files during recovery", async () => {
        const artifactRoot = path.join(taskDirectory, "artifacts")
        const imagesDirectory = path.join(artifactRoot, "images")
        await fs.mkdir(imagesDirectory, { recursive: true })
        const stalePartialPath = path.join(imagesDirectory, "orphan.partial")
        await fs.writeFile(stalePartialPath, PNG_1X1)
        await fs.utimes(stalePartialPath, new Date(0), new Date(0))
        const staleTemporaryPath = path.join(
            imagesDirectory,
            `${"a".repeat(64)}.png.123.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`,
        )
        await fs.writeFile(staleTemporaryPath, PNG_1X1)
        await fs.utimes(staleTemporaryPath, new Date(0), new Date(0))
        await fs.writeFile(
            path.join(artifactRoot, "manifest.json"),
            JSON.stringify({ schemaVersion: 999, taskId: "task-1", artifacts: [] }),
            "utf8",
        )

        const store = new TaskArtifactStore({ taskId: "task-1", taskDirectory, now: () => 120_000 })
        await expectArtifactError(store.listImages(), "unsupported_manifest_version")
        expect(await fs.readdir(imagesDirectory)).toEqual([])
    })
})
