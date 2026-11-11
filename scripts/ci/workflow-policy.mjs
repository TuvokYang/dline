import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const SHA = /^[0-9a-f]{40}$/
const TESTS_WORKFLOW = ".github/workflows/test.yml"

function requireSha(value) {
    if (!SHA.test(value ?? "")) throw new Error("Expected a full lowercase commit SHA.")
    return value
}

function isTestsPush(run, repository, sha) {
    return (
        run.head_repository?.full_name === repository &&
        run.path === TESTS_WORKFLOW &&
        run.event === "push" &&
        run.head_branch === "dev" &&
        run.head_sha === sha
    )
}

export function hasTestedPackages(artifacts, sha) {
    return [`dline-vsix-${sha}`, `dline-vscode-marketplace-vsix-${sha}`].every((name) =>
        artifacts.some((artifact) => artifact.name === name && artifact.expired === false && artifact.size_in_bytes > 0),
    )
}

/** Reuse dev evidence only for a content-preserving dev back-merge. */
export async function resolveTestExecution(context, ports) {
    const execute = (reason) => ({ run_tests: "true", reason })
    if (context.event !== "push" || context.ref !== "refs/heads/dev") {
        return execute("This event requires its own gate.")
    }
    if (!SHA.test(context.before ?? "") || /^0+$/.test(context.before)) return execute("No previous branch commit is available.")

    const current = await ports.readCommit(requireSha(context.sha))
    if (current.parents.length !== 2 || current.parents[0] !== context.before) {
        return execute("Not a supported promotion or back-merge.")
    }
    const candidate = context.before
    const previous = await ports.readCommit(candidate)
    if (current.tree !== previous.tree) return execute("Repository content differs from the dev candidate.")

    // A newer failed/running attempt must not be hidden by an older successful run.
    const latest = (await ports.listRuns(candidate))
        .filter((run) => isTestsPush(run, context.repository, candidate))
        .sort((left, right) => right.id - left.id)[0]
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
        return execute("The dev candidate has no current successful Tests run.")
    }
    if (!hasTestedPackages(await ports.listArtifacts(latest.id), candidate)) {
        return execute("The previous successful run has no complete live package evidence.")
    }
    return {
        run_tests: "false",
        reused_run_id: String(latest.id),
        reason: "Reusing the gate of an identical verified dev tree.",
    }
}

/** A normal successful Tests run must still publish; only the explicit reuse-only run is suppressed. */
export function isReusedTestRun(jobs) {
    return (
        jobs.some((job) => job.name === "Resolve test execution" && job.conclusion === "success") &&
        jobs.some((job) => ["Checks", "TypeScript"].includes(job.name) && job.conclusion === "skipped") &&
        jobs.filter((job) => job.name !== "Resolve test execution").every((job) => job.conclusion === "skipped")
    )
}

function command(file, args) {
    return execFileSync(file, args, {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
    }).trim()
}

function github(repository, endpoint) {
    return JSON.parse(command("gh", ["api", `repos/${repository}/${endpoint}`]))
}

function artifacts(repository, runId) {
    const pages = JSON.parse(
        command("gh", ["api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`]),
    )
    return pages.flatMap((page) => page.artifacts)
}

async function main(action, env) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    const repository = env.GITHUB_REPOSITORY
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("A GitHub repository identity is required.")
    let result
    if (action === "test-gate") {
        result = await resolveTestExecution(
            { event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, sha: env.GITHUB_SHA, before: event.before, repository },
            {
                readCommit: (sha) => {
                    const [tree, parents] = command("git", ["show", "--no-patch", "--format=%T%n%P", requireSha(sha)]).split("\n")
                    return { tree: tree.trim(), parents: parents?.trim().split(/\s+/).filter(Boolean) ?? [] }
                },
                listRuns: (sha) =>
                    github(repository, `actions/workflows/test.yml/runs?branch=dev&event=push&head_sha=${sha}&per_page=100`)
                        .workflow_runs,
                listArtifacts: (runId) => artifacts(repository, runId),
            },
        )
    } else if (action === "insiders-gate") {
        const runId = String(event.workflow_run?.id ?? "")
        if (env.GITHUB_EVENT_NAME !== "workflow_run" || !/^[1-9][0-9]*$/.test(runId)) {
            throw new Error("Expected a completed Tests workflow event.")
        }
        const pages = JSON.parse(
            command("gh", ["api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`]),
        )
        const reused = isReusedTestRun(pages.flatMap((page) => page.jobs))
        result = {
            eligible: reused ? "false" : "true",
            reason: reused
                ? "Skipping duplicate Insiders publication for a reused test gate."
                : "Normal tested Insiders publication remains eligible.",
        }
    } else {
        throw new Error("Expected test-gate or insiders-gate.")
    }
    for (const [key, value] of Object.entries(result)) {
        if (/[\r\n]/.test(value)) throw new Error("Workflow outputs must contain a single line.")
        appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
    }
    console.log(result.reason)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv[2], process.env).catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
}
