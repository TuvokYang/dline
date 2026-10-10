const createUserContentPattern = () => /(<(task|feedback|answer|user_message)>)([\s\S]*?)(<\/\2>)/gi

/** Transform only explicitly tagged user-authored text without rescanning transformed values. */
export async function processUserContentTags(text: string, transform: (userText: string) => Promise<string>): Promise<string> {
    let output = ""
    let cursor = 0
    let match: RegExpExecArray | null
    const pattern = createUserContentPattern()

    while ((match = pattern.exec(text)) !== null) {
        output += text.slice(cursor, match.index)
        output += match[1]
        output += await transform(match[3])
        output += match[4]
        cursor = match.index + match[0].length
    }

    return cursor === 0 ? text : output + text.slice(cursor)
}
