import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"

const READY_TIMEOUT = 10_000
const STOP_TIMEOUT = 5_000

function displayNumber(server: ChildProcessWithoutNullStreams): Promise<string> {
    return new Promise((resolve, reject) => {
        let output = ""
        let diagnostic = ""
        const cleanup = () => {
            clearTimeout(timer)
            server.stdout.off("data", onData)
            server.stderr.off("data", onErrorData)
            server.off("error", onError)
            server.off("exit", onExit)
        }
        const fail = (error: Error) => {
            cleanup()
            reject(error)
        }
        const onError = (error: Error) => fail(error)
        const onExit = () => fail(new Error(`Worker Xvfb exited before readiness: ${diagnostic}`))
        const onErrorData = (chunk: Buffer) => {
            diagnostic = (diagnostic + chunk.toString()).slice(-2_000)
        }
        const onData = (chunk: Buffer) => {
            output += chunk.toString()
            const newline = output.indexOf("\n")
            if (newline < 0 && output.length < 32) return
            const number = output.slice(0, newline).trim()
            if (newline < 0 || !/^\d{1,5}$/.test(number) || Number(number) > 65_535) {
                fail(new Error("Worker Xvfb returned an invalid display number"))
                return
            }
            cleanup()
            resolve(`:${number}`)
        }
        const timer = setTimeout(() => fail(new Error(`Worker Xvfb readiness timed out: ${diagnostic}`)), READY_TIMEOUT)
        server.stdout.on("data", onData)
        server.stderr.on("data", onErrorData)
        server.once("error", onError)
        server.once("exit", onExit)
    })
}

async function stopDisplay(server: ChildProcessWithoutNullStreams): Promise<void> {
    if (server.pid === undefined || server.exitCode !== null || server.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>
        const cleanup = () => {
            clearTimeout(timer)
            server.off("exit", onExit)
        }
        const onExit = () => {
            cleanup()
            resolve()
        }
        server.once("exit", onExit)
        timer = setTimeout(() => {
            timer = setTimeout(() => {
                cleanup()
                reject(new Error("Worker Xvfb did not exit after SIGKILL"))
            }, STOP_TIMEOUT)
            server.kill("SIGKILL")
        }, STOP_TIMEOUT)
        server.kill("SIGTERM")
    })
}

/** Keep native focus local to one Linux CI worker, including all of its multi-window tests. */
export async function withWorkerDisplay(
    run: () => Promise<void>,
    environment: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): Promise<void> {
    if (platform !== "linux" || !environment.CI) {
        await run()
        return
    }
    const server = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp", "-ac"], {
        env: environment,
        stdio: "pipe",
    })
    const previous = environment.DISPLAY
    try {
        environment.DISPLAY = await displayNumber(server)
        await run()
        if (server.exitCode !== null || server.signalCode !== null) throw new Error("Worker Xvfb exited during the tests")
    } finally {
        if (previous === undefined) delete environment.DISPLAY
        else environment.DISPLAY = previous
        await stopDisplay(server)
    }
}
