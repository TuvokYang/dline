import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"
import { DOCS_ASSETS_DIR } from "../../src/data/assets.mjs"
import { remarkThemedImages } from "../../src/plugins/remark-themed-images.mjs"

const LIGHT_FILES = new Set([path.join(DOCS_ASSETS_DIR, "ui", "demo-light.gif")])

/** @param {string} url */
const image = (url) => ({ type: "image", url, alt: "Demo", title: null })

/** @param {unknown[]} children */
function transform(children) {
    const tree = { type: "root", children: [{ type: "paragraph", children }] }
    remarkThemedImages({ exists: (filePath) => LIGHT_FILES.has(filePath) })(tree)
    return tree.children[0].children
}

/** @param {any} node */
const classesOf = (node) => node.data?.hProperties?.className

describe("remarkThemedImages", () => {
    it("follows a capture with its light edition and lets the theme pick one", () => {
        const [dark, light, ...rest] = transform([image("@docs-assets/ui/demo.gif")])

        assert.equal(rest.length, 0)
        assert.equal(dark.url, "@docs-assets/ui/demo.gif")
        assert.deepEqual(classesOf(dark), ["light:sl-hidden"])
        assert.equal(light.type, "image")
        assert.equal(light.url, "@docs-assets/ui/demo-light.gif")
        assert.equal(light.alt, "Demo")
        assert.deepEqual(classesOf(light), ["dark:sl-hidden"])
    })

    it("leaves a capture without a light edition, and any other image, as it was", () => {
        const children = transform([image("@docs-assets/ui/other.gif"), image("https://example.com/shot.png")])

        assert.deepEqual(
            children.map((node) => [node.url, classesOf(node)]),
            [
                ["@docs-assets/ui/other.gif", undefined],
                ["https://example.com/shot.png", undefined],
            ],
        )
    })

    it("pairs each capture once, even when two sit in the same paragraph", () => {
        const children = transform([
            image("@docs-assets/ui/demo.gif"),
            { type: "text", value: " " },
            image("@docs-assets/ui/demo.gif"),
        ])

        assert.deepEqual(
            children.map((node) => node.url ?? node.type),
            [
                "@docs-assets/ui/demo.gif",
                "@docs-assets/ui/demo-light.gif",
                "text",
                "@docs-assets/ui/demo.gif",
                "@docs-assets/ui/demo-light.gif",
            ],
        )
    })
})
