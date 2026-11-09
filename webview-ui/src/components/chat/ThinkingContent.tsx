import { memo, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"

const ELEMENTS = [
    "p",
    "strong",
    "em",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
]

function Heading({ children }: { children?: ReactNode }) {
    return <p className="font-semibold">{children}</p>
}

const COMPONENTS = { h1: Heading, h2: Heading, h3: Heading, h4: Heading, h5: Heading, h6: Heading }

/** Read-only reasoning typography without file probes, links, remote images, or rich block execution. */
export const ThinkingContent = memo(({ content }: { content?: string }) => (
    <div className="text-sm break-words [overflow-wrap:anywhere] [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-description/30 [&_blockquote]:pl-2 [&_pre]:my-1 [&_pre]:whitespace-pre-wrap [&_pre]:rounded [&_pre]:bg-code [&_pre]:p-2 [&_code]:font-mono [&_code]:text-[0.9em]">
        <ReactMarkdown allowedElements={ELEMENTS} components={COMPONENTS} skipHtml unwrapDisallowed>
            {content ?? ""}
        </ReactMarkdown>
    </div>
))

ThinkingContent.displayName = "ThinkingContent"
