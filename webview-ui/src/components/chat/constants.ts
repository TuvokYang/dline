/**
 * Shared constants for chat components
 */

/**
 * Marker string used to separate hook metadata from hook output in hook messages.
 * When a hook executes, its metadata (status, tool info, etc.) is followed by this
 * marker, which is then followed by the actual output from the hook script.
 */
export const HOOK_OUTPUT_STRING = "__HOOK_OUTPUT__"

/** Layout of the icon-and-title header that opens a chat row. */
export const CHAT_ROW_HEADER_CLASSNAMES = "flex items-center gap-2.5 mb-3"

/** Maximum height shared by uncapped tool response surfaces. */
export const TOOL_RESPONSE_MAX_HEIGHT = "60vh"

/** Keep horizontal containment; vertical edges must hand scrolling back to the conversation. */
export const TOOL_RESPONSE_SCROLL_CLASS = "max-h-[60vh] overflow-y-auto overscroll-x-contain"
