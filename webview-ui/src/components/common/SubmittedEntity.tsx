import { StringRequest } from "@shared/proto/dline/common"
import { FileServiceClient } from "@/services/grpc-client"

/** One active command or mention of a sent row, drawn the way the composer drew it. */
export function SubmittedEntity({
    role,
    text,
    withShadow = true,
}: {
    role: "command" | "mention"
    text: string
    withShadow?: boolean
}): JSX.Element {
    const className = withShadow ? "mention-context-highlight-with-shadow" : "mention-context-highlight"
    if (role === "command") return <span className={className}>{text}</span>
    // The lexer keeps the leading `@` in the source text, while openMention
    // addresses the target without it.
    const target = text.replace(/^@/, "")
    return (
        // A button rather than a span: opening a mention is an action, so it
        // has to be reachable and activatable from the keyboard.
        <button
            className={`${className} cursor-pointer bg-transparent border-0 p-0 font-inherit`}
            onClick={() => FileServiceClient.openMention(StringRequest.create({ value: target }))}
            type="button">
            {text}
        </button>
    )
}
