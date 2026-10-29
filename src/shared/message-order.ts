/** Keep presentation order independent of arrival or persistence order without mutating the source window. */
export function orderMessagesByTs<T extends { readonly ts: number }>(messages: T[]): T[] {
    for (let index = 1; index < messages.length; index++) {
        if (messages[index - 1].ts > messages[index].ts) {
            return [...messages].sort((left, right) => left.ts - right.ts)
        }
    }
    return messages
}
