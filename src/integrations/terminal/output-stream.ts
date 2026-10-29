import type { Writable } from "node:stream"
import type { TerminalOutputLine, TerminalOutputStream } from "./types"

const OUTPUT_STREAM_LABELS: Record<TerminalOutputStream, string> = {
    stdout: "O",
    stderr: "E",
    combined: "C",
}

export function formatTerminalOutputLogLine(output: TerminalOutputLine): string {
    const label = OUTPUT_STREAM_LABELS[output.stream]
    return output.line ? `[${label}] ${output.line}` : `[${label}]`
}

/** Write text and wait when the writable stream applies backpressure. */
export async function writeTerminalOutputText(stream: Writable, content: string): Promise<void> {
    if (!content || stream.write(content)) return
    await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
            stream.off("error", onError)
            resolve()
        }
        const onError = (error: Error) => {
            stream.off("drain", onDrain)
            reject(error)
        }
        stream.once("drain", onDrain)
        stream.once("error", onError)
    })
}

/** Wait until all writes admitted before this call reach the writable implementation. */
export async function flushTerminalOutputStream(stream: Writable): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            stream.off("error", onError)
            reject(error)
        }
        stream.once("error", onError)
        stream.write("", () => {
            stream.off("error", onError)
            resolve()
        })
    })
}

/** Write one output frame while preserving stream labels and event order. */
export async function writeTerminalOutputFrame(stream: Writable, output: readonly TerminalOutputLine[]): Promise<void> {
    if (output.length === 0) return
    await writeTerminalOutputText(stream, `${output.map(formatTerminalOutputLogLine).join("\n")}\n`)
}

export function formatTerminalOutput(output: readonly TerminalOutputLine[], processOutput: (lines: string[]) => string): string {
    return processOutput(output.map(formatTerminalOutputLogLine))
}

export function splitTerminalOutput(output: readonly TerminalOutputLine[]): {
    outputEntries: TerminalOutputLine[]
    outputLines: string[]
    stdoutLines: string[]
    stderrLines: string[]
    combinedOutputLines: string[]
} {
    return {
        outputEntries: output.map((entry) => ({ ...entry })),
        outputLines: output.map((entry) => entry.line),
        stdoutLines: output.filter((entry) => entry.stream === "stdout").map((entry) => entry.line),
        stderrLines: output.filter((entry) => entry.stream === "stderr").map((entry) => entry.line),
        combinedOutputLines: output.filter((entry) => entry.stream === "combined").map((entry) => entry.line),
    }
}
