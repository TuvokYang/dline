/**
 * Strip a single leading slash from a workspace-relative input path
 * to prevent path.resolve() from interpreting it as a drive-relative
 * absolute path on Windows.
 *
 * Node.js path.resolve() on Windows treats "/src/a.ts" as a path
 * relative to the current drive root (e.g. "E:\src\a.ts"), discarding
 * cwd entirely. This function normalizes such inputs before they reach
 * path.resolve() or path.isAbsolute().
 *
 * This function is a no-op on POSIX platforms where "/src/a.ts" IS
 * a valid absolute path.
 *
 * Handles:
 *   "/src/a.ts"  -> "src/a.ts"          (strip leading /)
 *   "\src\a.ts"  -> "src\a.ts"          (strip leading \)
 *   "/E:/x"      -> "E:/x"              (strip leading / from drive path)
 *   "C:\foo"     -> "C:\foo"            (preserve absolute)
 *   "C:/foo"     -> "C:/foo"            (preserve absolute)
 *   "\\srv\sh"   -> "\\srv\sh"          (preserve UNC)
 *   "//srv/sh"   -> "//srv/sh"          (preserve UNC)
 *   "@ws:src/x"  -> "@ws:src/x"         (preserve workspace hint)
 *   "src/a.ts"   -> "src/a.ts"          (no change)
 *   ""           -> ""                  (no change)
 *
 * @param input - The raw path input (may come from AI tool call)
 * @param platform - Override process.platform for testing (default: process.platform)
 * @returns Normalized workspace-relative path
 */
export function normalizeWorkspaceRelativeInputPath(input: string, platform: string = process.platform): string {
    if (!input) {
        return input
    }

    // No-op on POSIX: "/src/a.ts" is a valid absolute path on Linux/macOS
    if (platform !== "win32") {
        return input
    }

    // Preserve workspace hints: "@frontend:src/index.ts"
    if (input.startsWith("@")) {
        return input
    }

    // Preserve Windows drive-letter absolute paths: C:\foo, C:/foo
    if (/^[a-zA-Z]:[/\\]/.test(input)) {
        return input
    }

    // Preserve UNC paths: \\server\share, //server/share
    if (input.startsWith("\\\\") || input.startsWith("//")) {
        return input
    }

    // Strip a single leading '/' or '\'
    //   "/src/a.ts" → "src/a.ts"
    //   "\src\a.ts" → "src\a.ts"
    //   "/E:/x"     → "E:/x"
    if (input.startsWith("/") || input.startsWith("\\")) {
        return input.slice(1)
    }

    return input
}
