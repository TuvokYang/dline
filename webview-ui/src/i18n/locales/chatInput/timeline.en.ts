const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`
type ScaleArgs = { count: number; files?: number; truncated: boolean }
const scale = ({ count, files, truncated }: ScaleArgs, singular: string, pluralForm: string) => {
    const amount = `${count}${truncated ? "+" : ""}`
    return ` (${amount} ${count === 1 && !truncated ? singular : pluralForm}${files ? ` · ${plural(files, "file")}` : ""})`
}
type ReadArgs = { path: string; start?: number; end?: number; pending?: boolean }

export const timelineEn = {
    "chatInput.welcome.current": ({ label, branch }: { label: string; branch: string }) => `${label} ${branch}`,
    "chatInput.welcome.currentLabel": "Current:",
    "chatInput.welcome.detached": "detached HEAD",
    "chatInput.welcome.worktrees": "View and manage git worktrees. Great for running parallel Dline tasks.",
    "chatInput.timeline.collapseAll": "Collapse all activity",
    "chatInput.timeline.expandAll": "Expand all activity",
    "chatInput.timeline.bottom": "Scroll to bottom",
    "chatInput.timeline.top": "Scroll to top",
    "chatInput.timeline.thinking": "Thinking",
    "chatInput.trajectory.title": "Conversation trajectory",
    "chatInput.trajectory.jump": ({ prompt }: { prompt: string }) => `Jump to message: ${prompt}`,
    "chatInput.trajectory.attempt": ({ number }: { number: number }) => `Phase ${number}`,
    "chatInput.trajectory.turn": ({ number }: { number: number }) => `Turn ${number}`,
    "chatInput.trajectory.rounds": ({ count }: { count: number }) => plural(count, "round"),
    "chatInput.fold.rounds": ({ count }: { count: number }) => plural(count, "round"),
    "chatInput.fold.work.read": ({ count }: { count: number }) => plural(count, "file read"),
    "chatInput.fold.work.write": ({ count }: { count: number }) => plural(count, "file edit"),
    "chatInput.fold.work.command": ({ count }: { count: number }) => plural(count, "cmd"),
    "chatInput.fold.work.subagent": ({ count }: { count: number }) => plural(count, "subagent"),
    "chatInput.fold.work.web": ({ count }: { count: number }) => `${count} web tools`,
    "chatInput.fold.work.browser": ({ count }: { count: number }) => plural(count, "browser"),
    "chatInput.fold.work.other": ({ count }: { count: number }) => plural(count, "other"),
    "chatInput.fold.mcp": ({ servers, tools, failed }: { servers: number; tools: number; failed: number }) =>
        `${servers} MCP (${plural(tools, "tool")}, ${failed} failed)`,
    "chatInput.fold.thoughts": ({ count }: { count: number }) => plural(count, "thought"),
    "chatInput.fold.checkpoints": ({ count }: { count: number }) => plural(count, "checkpoint"),
    "chatInput.fold.messages": ({ count }: { count: number }) => plural(count, "message"),
    "chatInput.fold.withExternal": ({ work, external }: { work: string; external: number }) => `${work} (${external} external)`,
    "chatInput.fold.failure.edit": ({ count }: { count: number }) => `${count} file edit failed`,
    "chatInput.fold.failure.read": ({ count }: { count: number }) => `${count} file read failed`,
    "chatInput.fold.failure.subagent": ({ count }: { count: number }) => `${count} subagent failed`,
    "chatInput.fold.failure.command": ({ count }: { count: number }) => `${count} cmd failed`,
    "chatInput.fold.failure.web": ({ count }: { count: number }) => `${count} web tools failed`,
    "chatInput.fold.failure.browser": ({ count }: { count: number }) => `${count} browser failed`,
    "chatInput.fold.finished": "Finished steps",
    "chatInput.fold.subagents": ({ agents }: { agents: string }) => `Subagents: ${agents}`,
    "chatInput.fold.external": ({ work }: { work: string }) => `External by verb: ${work}`,
    "chatInput.fold.kind.read": "read",
    "chatInput.fold.kind.write": "write",
    "chatInput.fold.kind.command": "command",
    "chatInput.fold.kind.subagent": "subagent",
    "chatInput.fold.kind.web": "web",
    "chatInput.fold.kind.browser": "browser",
    "chatInput.fold.kind.other": "other",
    "chatInput.fold.usageTokens": ({ input, output }: { input: string; output: string }) => `${input} in / ${output} out`,
    "chatInput.tool.matchScale": (args: ScaleArgs) => scale(args, "match", "matches"),
    "chatInput.tool.refScale": (args: ScaleArgs) => scale(args, "ref", "refs"),
    "chatInput.tool.searchDisplay": ({ target, path, suffix }: { target: string; path: string; suffix: string }) =>
        `${target} in ${path}${suffix}`,
    "chatInput.tool.inSeparator": " in ",
    "chatInput.tool.references": "references",
    "chatInput.tool.lines": ({ start, end }: { start: number; end: number }) => `lines ${start}-${end}`,
    "chatInput.tool.reading": ({ path, start, end, pending }: ReadArgs) =>
        `Reading ${path}${start != null && end != null ? ` (lines ${start}-${end})` : ""}${pending ? "..." : ""}`,
    "chatInput.tool.readingPrefix": "Reading",
    "chatInput.tool.exploring": ({ path, pending }: { path: string; pending?: boolean }) =>
        `Exploring ${path}/${pending ? "..." : ""}`,
    "chatInput.tool.exploringPrefix": "Exploring",
    "chatInput.tool.searching": ({ target, pending }: { target: string; pending?: boolean }) =>
        `Searching ${target}${pending ? "..." : ""}`,
    "chatInput.tool.finding": ({ target, pending }: { target: string; pending?: boolean }) =>
        `Finding ${target}${pending ? "..." : ""}`,
    "chatInput.tool.analyzing": ({ path, pending }: { path: string; pending?: boolean }) =>
        `Analyzing ${path}/${pending ? "..." : ""}`,
    "chatInput.tool.analyzingPrefix": "Analyzing",
    "chatInput.tool.preview": " (preview)",
    "chatInput.tool.rename": ({
        count,
        files,
        preview,
        name,
    }: {
        count: number | string
        files: number | string
        preview: boolean
        name?: string
    }) => `${count} changes in ${files} files${preview ? " (preview)" : ""}${name ? ` → "${name}"` : ""}`,
    "chatInput.tool.replace": ({
        count,
        files,
        preview,
        find,
    }: {
        count: number | string
        files: number | string
        preview: boolean
        find?: string
    }) =>
        find ? `"${find}" → (${count} in ${files} files)${preview ? " (preview)" : ""}` : `${count} changes in ${files} files`,
    "chatInput.tool.summary": ({
        read,
        list,
        def,
        search,
        refs,
    }: {
        read: number
        list: number
        def: number
        search: number
        refs: number
    }) => {
        const parts = [
            read ? plural(read, "file") : "",
            list ? plural(list, "folder") : "",
            def ? plural(def, "definition") : "",
            search ? `performed ${plural(search, "search", "searches")}` : "",
            refs ? `found ${plural(refs, "reference")}` : "",
        ].filter(Boolean)
        return parts.length ? `Dline${read || list ? " read " : " "}${parts.join(", ")}` : "Context"
    },
    "chatInput.tool.exploration": ({ tools, thoughts, rounds }: { tools: string; thoughts: number; rounds: number }) =>
        [tools, thoughts > 0 ? plural(thoughts, "thought") : "", rounds > 1 ? `${rounds} rounds` : ""]
            .filter(Boolean)
            .join(" · "),
} as const
