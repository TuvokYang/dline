import { StringRequest } from "@shared/proto/dline/common"
import { SquareArrowOutUpRightIcon } from "lucide-react"
import { marked } from "marked"
import type { ComponentProps } from "react"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import rehypeHighlight, { Options } from "rehype-highlight"
import remarkGfm from "remark-gfm"
import type { Node } from "unist"
import { visit } from "unist-util-visit"
import type { TransitionDraftComposer } from "@/components/chat/mode-switch/transitionDraft"
import { type ModeSwitchDraft, useModeSwitch } from "@/components/chat/mode-switch/useModeSwitch"
import LatexBlock from "@/components/common/LatexBlock"
import MermaidBlock from "@/components/common/MermaidBlock"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"
import { parseSubmittedEntityLink } from "@/services/input-semantics/highlight"
import { WithCopyButton } from "./CopyButton"
import { LinkedResourceChip } from "./ResourceChip"
import { SubmittedEntity } from "./SubmittedEntity"
import UnsafeImage from "./UnsafeImage"

/**
 * Fenced code block languages that are typeset as math instead of highlighted code.
 * Keep in sync with the capability declaration in the system prompt.
 */
const LATEX_LANGUAGE_PATTERN = /(?:^|\s)language-(?:latex|math|tex)(?:\s|$)/

/** Opening fence of a math code block, capturing its fence run so the closer can be matched. */
const MATH_FENCE_OPENING_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(?:latex|math|tex)[ \t]*$/

/**
 * Reports whether a markdown block is a math fence that has not been closed yet.
 *
 * Both `marked` and CommonMark let a fenced block end implicitly at EOF, so a
 * streaming response emits a complete-looking code token while the formula is
 * still half-written. Typesetting that partial source produces flicker and
 * throws away work on every chunk, so such a block stays plain text until its
 * closing fence arrives.
 */
export function isUnterminatedMathFence(block: string): boolean {
    const lines = block.split("\n")
    const opening = lines[0] !== undefined ? MATH_FENCE_OPENING_PATTERN.exec(lines[0]) : null
    if (!opening) {
        return false
    }

    const fence = opening[1]
    const closingPattern = new RegExp(`^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*$`)
    return !lines.slice(1).some((line) => closingPattern.test(line))
}

/**
 * Returns the `className` of a `<pre>`'s single `<code>` child.
 *
 * react-markdown does not guarantee that `children` is an array, so the child is
 * normalized through React.Children instead of relying on Array.isArray.
 */
function getSoleCodeChildClassName(children: React.ReactNode): string | undefined {
    const items = React.Children.toArray(children)
    if (items.length !== 1) {
        return undefined
    }
    const child = items[0]
    if (!React.isValidElement(child)) {
        return undefined
    }
    return (child as React.ReactElement<{ className?: string }>).props?.className
}

function parseMarkdownIntoBlocks(markdown: string): string[] {
    try {
        const tokens = marked.lexer(markdown)
        return tokens?.map((token) => token.raw)
    } catch {
        return [markdown]
    }
}

const MemoizedMarkdownBlock = memo(
    ({ content, submittedEntities }: { content: string; submittedEntities?: boolean }) => {
        // A streaming math fence stays highlighted source until its closing fence arrives.
        const typesetMath = !isUnterminatedMathFence(content)
        return (
            <ReactMarkdown
                components={{
                    pre: ({ children, ...preProps }: React.HTMLAttributes<HTMLPreElement>) => {
                        const childClassName = getSoleCodeChildClassName(children) ?? ""
                        // Specialized blocks render their own container, so drop the <pre> wrapper.
                        const isMath = typesetMath && LATEX_LANGUAGE_PATTERN.test(childClassName)
                        if (childClassName.includes("language-mermaid") || isMath) {
                            return <>{children}</>
                        }
                        return <PreWithCopyButton {...preProps}>{children}</PreWithCopyButton>
                    },
                    code: (props: ComponentProps<"code"> & { [key: string]: any }) => {
                        const className = props.className || ""
                        if (className.includes("language-mermaid")) {
                            const codeText = String(props.children || "")
                            return <MermaidBlock code={codeText} />
                        }
                        if (typesetMath && LATEX_LANGUAGE_PATTERN.test(className)) {
                            // Fenced code content carries a trailing newline from the markdown source.
                            return <LatexBlock code={String(props.children || "").replace(/\n$/, "")} />
                        }

                        // Use the async file check component for potential file paths
                        return <InlineCodeWithFileCheck {...props} />
                    },
                    a: (props: ComponentProps<"a">) => <MarkdownLink {...props} submittedEntities={submittedEntities} />,
                    strong: (props: ComponentProps<"strong">) => {
                        // Check if this is an "Act Mode" strong element by looking for the keyboard shortcut
                        // Handle both string children and array of children cases
                        const childrenText = React.Children.toArray(props.children)
                            .map((child) => {
                                if (typeof child === "string") {
                                    return child
                                }
                                if (typeof child === "object" && "props" in child && child.props.children) {
                                    return String(child.props.children)
                                }
                                return ""
                            })
                            .join("")

                        // Case-insensitive check for "Act Mode (⌘⇧A)" pattern
                        // This ensures we only style the exact "Act Mode" mentions with keyboard shortcut
                        // Using case-insensitive flag to catch all capitalization variations
                        if (/^act mode\s*\(⌘⇧A\)$/i.test(childrenText)) {
                            return <ActModeHighlight />
                        }

                        return <strong {...props} />
                    },
                    img: (props) => <UnsafeImage {...props} />,
                }}
                rehypePlugins={[[rehypeHighlight as any, {} as Options]]}
                remarkPlugins={[
                    [remarkGfm, { singleTilde: false }],
                    remarkPreventBoldFilenames,
                    remarkUrlToLink,
                    remarkHighlightActMode,
                    remarkMarkPotentialFilePaths,
                    () => {
                        return (tree: any) => {
                            visit(tree, "code", (node: any) => {
                                if (!node.lang) {
                                    node.lang = "javascript"
                                } else if (node.lang.includes(".")) {
                                    node.lang = node.lang.split(".").slice(-1)[0]
                                }
                            })
                        }
                    },
                ]}>
                {content}
            </ReactMarkdown>
        )
    },
    (prevProps, nextProps) => {
        if (prevProps.content !== nextProps.content) return false
        return prevProps.submittedEntities === nextProps.submittedEntities
    },
)

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock"

const MemoizedMarkdown = memo(
    ({ content, id, submittedEntities }: { content: string; id: string; submittedEntities?: boolean }) => {
        const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content])
        return blocks?.map((block, index) => (
            <MemoizedMarkdownBlock content={block} key={`${id}-block_${index}`} submittedEntities={submittedEntities} />
        ))
    },
)

MemoizedMarkdown.displayName = "MemoizedMarkdown"

/** The Act Mode link switches without a draft, so it never has one to send on or let go of. */
const NO_DRAFT: ModeSwitchDraft = { text: "", images: [], files: [] }
const NO_DRAFT_COMPOSER: TransitionDraftComposer<ModeSwitchDraft> = { holds: () => false, retire: () => undefined }

/**
 * A component for Act Mode text that contains a clickable toggle and keyboard shortcut hint.
 */
const ActModeHighlight: React.FC = () => {
    const { mode, modeSwitch, stateRevision } = useExtensionState()
    const modeSwitchFlow = useModeSwitch({
        mode,
        stateRevision,
        modeSwitch,
        draft: NO_DRAFT,
        onSend: () => undefined,
        composer: NO_DRAFT_COMPOSER,
    })
    const canSwitchToAct = mode === "plan" && !modeSwitchFlow.isSwitchPending

    /** Request Act mode through the shared backend transaction. */
    const handleSwitchToAct = useCallback(async () => {
        if (!canSwitchToAct) return
        await modeSwitchFlow.requestSwitch("act")
    }, [canSwitchToAct, modeSwitchFlow.requestSwitch])

    return (
        <span
            className={cn("text-link inline-flex items-center gap-1", {
                "hover:opacity-90 cursor-pointer": canSwitchToAct,
                "cursor-not-allowed opacity-60": !canSwitchToAct,
            })}
            onClick={() => void handleSwitchToAct()}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    void handleSwitchToAct()
                }
            }}
            role="button"
            tabIndex={canSwitchToAct ? 0 : -1}
            title={canSwitchToAct ? "Click to toggle to Act Mode" : "Already in Act Mode"}>
            <span
                aria-hidden="true"
                className="p-1 rounded-md bg-code flex items-center justify-end w-7 border border-input-border">
                <span className="rounded-full bg-link w-2 h-2" />
            </span>
            Act Mode (⌘⇧A)
        </span>
    )
}

interface MarkdownBlockProps {
    markdown?: string
    compact?: boolean
    showCursor?: boolean
    /**
     * Draw `#dline-entity/` links as the commands and mentions a sent row ran.
     *
     * Only a row built from its submitted facts may set this: in any other
     * Markdown, such as model output, the same link is ordinary text and must
     * not pass for an entity the user ran.
     */
    submittedEntities?: boolean
}

/**
 * Custom remark plugin that converts plain URLs in text into clickable links
 *
 * The original bug: We were converting text nodes into paragraph nodes,
 * which broke the markdown structure because text nodes should remain as text nodes
 * within their parent elements (like paragraphs, list items, etc.).
 * This caused the entire content to disappear because the structure became invalid.
 */
const isExistingLinkNode = (node: Node | null | undefined): boolean => node?.type === "link" || node?.type === "linkReference"

const remarkUrlToLink = () => {
    return (tree: Node) => {
        // Visit all "text" nodes in the markdown AST (Abstract Syntax Tree).
        visit(tree, "text", (node: any, index, parent) => {
            // GFM may already have linked a bare URL; never create a link inside that link.
            if (isExistingLinkNode(parent)) return

            const urlRegex = /https?:\/\/[^\s<>)"]+/g
            const matches = node.value.match(urlRegex)
            if (!matches) {
                return
            }

            const parts = node.value.split(urlRegex)
            const children: any[] = []

            parts.forEach((part: string, i: number) => {
                if (part) {
                    children.push({ type: "text", value: part })
                }
                if (matches[i]) {
                    children.push({
                        type: "link",
                        url: matches[i],
                        children: [{ type: "text", value: matches[i] }],
                    })
                }
            })

            // Fix: Instead of converting the node to a paragraph (which broke things),
            // we replace the original text node with our new nodes in the parent's children array.
            // This preserves the document structure while adding our links.
            if (parent) {
                parent.children.splice(index, 1, ...children)
            }
        })
    }
}

/**
 * Custom remark plugin that highlights "to Act Mode" mentions and adds keyboard shortcut hint
 */
const remarkHighlightActMode = () => {
    return (tree: Node) => {
        visit(tree, "text", (node: any, index, parent) => {
            // Case-insensitive regex to match "to Act Mode" in various capitalizations
            // Using word boundaries to avoid matching within words
            // Added negative lookahead to avoid matching if already followed by the shortcut
            const actModeRegex = /\bto\s+Act\s+Mode\b(?!\s*\(⌘⇧A\))/i

            if (!node.value.match(actModeRegex)) {
                return
            }

            // Split the text by the matches
            const parts = node.value.split(actModeRegex)
            const matches = node.value.match(actModeRegex)

            if (!matches || parts.length <= 1) {
                return
            }

            const children: any[] = []

            parts.forEach((part: string, i: number) => {
                // Add the text before the match
                if (part) {
                    children.push({ type: "text", value: part })
                }

                // Add the match, but only make "Act Mode" bold (not the "to" part)
                if (matches[i]) {
                    // Extract "to" and "Act Mode" parts
                    const matchText = matches[i]
                    const toIndex = matchText.toLowerCase().indexOf("to")
                    const actModeIndex = matchText.toLowerCase().indexOf("act mode", toIndex + 2)

                    if (toIndex !== -1 && actModeIndex !== -1) {
                        // Add "to" as regular text
                        const toPart = matchText.substring(toIndex, actModeIndex).trim()
                        children.push({ type: "text", value: `${toPart} ` })

                        // Add "Act Mode" as bold with keyboard shortcut
                        const actModePart = matchText.substring(actModeIndex)
                        children.push({
                            type: "strong",
                            children: [{ type: "text", value: `${actModePart} (⌘⇧A)` }],
                        })
                    } else {
                        // Fallback if we can't parse it correctly
                        children.push({ type: "text", value: `${matchText} ` })
                        children.push({
                            type: "strong",
                            children: [{ type: "text", value: `(⌘⇧A)` }],
                        })
                    }
                }
            })

            // Replace the original text node with our new nodes
            if (parent) {
                parent.children.splice(index, 1, ...children)
            }
        })
    }
}

/**
 * Custom remark plugin that prevents filenames with extensions from being parsed as bold text
 * For example: __init__.py should not be rendered as bold "init" followed by ".py"
 * Solves https://github.com/cline/cline/issues/1028
 */
const remarkPreventBoldFilenames = () => {
    return (tree: any) => {
        visit(tree, "strong", (node: any, index: number | undefined, parent: any) => {
            // Only process if there's a next node (potential file extension)
            if (!parent || typeof index === "undefined" || index === parent.children.length - 1) {
                return
            }

            const nextNode = parent.children[index + 1]

            // Check if next node is text and starts with . followed by extension
            if (nextNode.type !== "text" || !nextNode.value.match(/^\.[a-zA-Z0-9]+/)) {
                return
            }

            // If the strong node has multiple children, something weird is happening
            if (node.children?.length !== 1) {
                return
            }

            // Get the text content from inside the strong node
            const strongContent = node.children?.[0]?.value
            if (!strongContent || typeof strongContent !== "string") {
                return
            }

            // Validate that the strong content is a valid filename
            if (!strongContent.match(/^[a-zA-Z0-9_-]+$/)) {
                return
            }

            // Combine into a single text node
            const newNode = {
                type: "text",
                value: `__${strongContent}__${nextNode.value}`,
            }

            // Replace both nodes with the combined text node
            parent.children.splice(index, 2, newNode)
        })
    }
}

const PreWithCopyButton = ({ children, ...preProps }: React.HTMLAttributes<HTMLPreElement>) => {
    const preRef = useRef<HTMLPreElement>(null)

    const handleCopy = () => {
        if (preRef.current) {
            const codeElement = preRef.current.querySelector("code")
            const textToCopy = codeElement ? codeElement.textContent : preRef.current.textContent

            if (!textToCopy) {
                return
            }
            return textToCopy
        }
        return null
    }

    return (
        <WithCopyButton ariaLabel="Copy code" onCopy={handleCopy} position="top-right">
            <pre {...preProps} ref={preRef}>
                {children}
            </pre>
        </WithCopyButton>
    )
}

const BIDI_CONTROL_REGEX = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

function normalizeLocalPath(value: string): string {
    let decoded = value
    try {
        decoded = decodeURI(value)
    } catch {
        // Preserve malformed URI text so opening fails at the file-service boundary.
    }
    return decoded.replace(BIDI_CONTROL_REGEX, "").trim()
}

function isProjectRelativeLink(value: string): boolean {
    return (
        value.length > 0 &&
        !value.startsWith("#") &&
        !value.startsWith("/") &&
        !value.startsWith("\\") &&
        !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    )
}

// react-markdown passes an internal `node` prop to custom components; it must not
// leak onto the DOM as an attribute.
const MarkdownLink = ({
    href,
    onClick,
    node: _node,
    submittedEntities,
    ...props
}: ComponentProps<"a"> & { node?: unknown; submittedEntities?: boolean }) => {
    // A sent or queued user row marks its entities - commands and mentions it
    // ran, resources it carried - as entity links.
    const entity = submittedEntities ? parseSubmittedEntityLink(href) : undefined
    if (entity?.role === "resource") return <LinkedResourceChip displayName={entity.text} entityKey={entity.key} />
    if (entity) return <SubmittedEntity role={entity.role} text={entity.text} />
    const localPath = typeof href === "string" ? normalizeLocalPath(href) : ""
    const isLocal = isProjectRelativeLink(localPath)

    return (
        <a
            {...props}
            href={isLocal ? localPath : href}
            onClick={(event) => {
                onClick?.(event)
                if (!isLocal || event.defaultPrevented) return
                event.preventDefault()
                void FileServiceClient.openFileRelativePath(StringRequest.create({ value: localPath })).catch(
                    (error: unknown) => {
                        console.error(`Failed to open project file ${localPath}:`, error)
                    },
                )
            }}
        />
    )
}

// Regex to detect potential file paths (used in both remark plugin and component)
const FILE_PATH_REGEX = /^(?!\/)[\w\-./]+(?<!\/)$/

/**
 * Custom remark plugin that marks potential file paths in inline code blocks
 * This is synchronous - actual file existence checking happens in the React component
 */
const remarkMarkPotentialFilePaths = () => {
    return (tree: Node) => {
        visit(tree, "inlineCode", (node: Node & { value: string; data?: any }) => {
            node.value = normalizeLocalPath(node.value)
            if (FILE_PATH_REGEX.test(node.value) && !node.value.includes("\n")) {
                // Mark as potential file path - actual checking happens in React component
                node.data = node.data || {}
                node.data.hProperties = node.data.hProperties || {}
                node.data.hProperties["data-potential-file-path"] = "true"
            }
        })
    }
}

/**
 * Component that renders inline code and checks if it's a valid file path asynchronously
 * Shows the code immediately, then adds the file link icon when confirmed
 */
const InlineCodeWithFileCheck: React.FC<ComponentProps<"code"> & { [key: string]: any }> = (props) => {
    const [isFilePath, setIsFilePath] = useState<boolean | null>(null)
    const filePath = normalizeLocalPath(typeof props.children === "string" ? props.children : String(props.children || ""))
    const isPotentialFilePath = props["data-potential-file-path"] === "true"

    useEffect(() => {
        if (!isPotentialFilePath) {
            return
        }

        let cancelled = false

        // Check file existence asynchronously
        FileServiceClient.ifFileExistsRelativePath(StringRequest.create({ value: filePath }))
            .then((exists) => {
                if (!cancelled) {
                    setIsFilePath(exists.value)
                }
            })
            .catch((err) => {
                console.debug(`Failed to check file existence for ${filePath}:`, err)
                if (!cancelled) {
                    setIsFilePath(false)
                }
            })

        return () => {
            cancelled = true
        }
    }, [filePath, isPotentialFilePath])

    // If confirmed as a file path, render as clickable button
    if (isFilePath) {
        return (
            <Button
                className="p-0 ml-0.5 leading-none align-middle transition-opacity text-preformat gap-0.5 inline text-left"
                onClick={() => FileServiceClient.openFileRelativePath({ value: filePath })}
                size="icon"
                title={`Open ${filePath} in editor`}
                type="button"
                variant="icon">
                <code {...props} />
                <SquareArrowOutUpRightIcon className="inline align-middle ml-0.5" />
            </Button>
        )
    }

    // Otherwise render as regular code (shows immediately, before file check completes)
    return <code {...props} />
}

const MarkdownBlock = memo(({ markdown, compact, showCursor, submittedEntities }: MarkdownBlockProps) => {
    return (
        <div className="inline-markdown-block">
            <span
                className={cn("inline [&>p]:mt-0", {
                    "inline-cursor-container": showCursor,
                    "[&>p]:m-0": compact,
                })}>
                {markdown ? (
                    <MemoizedMarkdown content={markdown} id="markdown-block" submittedEntities={submittedEntities} />
                ) : (
                    markdown
                )}
            </span>
        </div>
    )
})

export default MarkdownBlock
