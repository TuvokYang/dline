#!/usr/bin/env node

/**
 * Keeps the stdio process alive without sending the MCP initialization response.
 * This deterministically models a server that spawned successfully but never
 * completed its protocol handshake.
 */
process.stdin.resume()
const keepAlive = setInterval(() => {}, 1_000)

const stop = () => {
    clearInterval(keepAlive)
    process.exit(0)
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)
process.stdin.once("end", stop)
