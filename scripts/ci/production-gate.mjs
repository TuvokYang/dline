import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { assertTagHead } from "./main-gate.mjs"

const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/

function positiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0
}

/** Select the latest exact tag test run, never an ordinary main run or an older success. */
export function resolveTagTests(runs, { repository, sha, tag }) {
    assertTagHead({ tag, sha, main: sha, tagged: sha })
    const latest = runs
        .filter(
            (run) =>
                run.path === ".github/workflows/test-main.yml" &&
                run.event === "push" &&
                run.head_branch === tag &&
                run.head_sha === sha &&
                run.head_repository?.full_name === repository,
        )
        .sort((left, right) => right.id - left.id)[0]
    if (!latest || latest.status !== "completed") return { status: "waiting" }
    if (latest.conclusion !== "success")
        throw new Error(`Tagged Main Tests ${latest.id} ended with ${latest.conclusion}; publication is blocked.`)
    if (!positiveInteger(latest.id) || !positiveInteger(latest.run_attempt)) throw new Error("Tag test identity is invalid.")
    return { status: "ready", id: latest.id, attempt: latest.run_attempt }
}

export async function awaitTagTests(context, ports, attempts = 600) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const gate = resolveTagTests(await ports.listRuns(), context)
        if (gate.status === "ready") {
            const jobs = await ports.listJobs(gate)
            const evidence = jobs.filter((job) => job.name === "Record production test evidence")
            if (evidence.length !== 1 || evidence[0].conclusion !== "success")
                throw new Error("The successful tag run must contain its completed production test evidence job.")
            return gate
        }
        if (attempt + 1 < attempts) await ports.pause()
    }
    throw new Error("Timed out waiting for tagged Main Tests; no tests or packages were started by publication.")
}

/** Bind package hashes to the exact successful run attempt that tested them. */
export function assertTestEvidence(evidence, { sha, tag, id, attempt }) {
    assertTagHead({ tag, sha, main: sha, tagged: sha })
    if (
        !positiveInteger(id) ||
        !positiveInteger(attempt) ||
        evidence?.commit_sha !== sha ||
        evidence?.tag !== tag ||
        evidence?.run_id !== id ||
        evidence?.run_attempt !== attempt ||
        evidence?.version !== tag.slice(1)
    )
        throw new Error("Production evidence does not belong to the validated tag, commit, and run attempt.")
    for (const [registry, prefix] of [
        ["open-vsx", "dline"],
        ["vscode-marketplace", "dline-vscode-marketplace"],
    ]) {
        const item = evidence.packages?.[registry]
        if (
            item?.artifact_name !== `${prefix}-vsix-${sha}` ||
            item?.asset_name !== `dline-${evidence.version}.vsix` ||
            !DIGEST.test(item?.sha256 ?? "")
        )
            throw new Error(`Invalid tested package evidence for ${registry}.`)
    }
    return evidence
}

export function createTestEvidence(env) {
    const evidence = {
        tag: env.RELEASE_TAG,
        version: env.RELEASE_TAG?.slice(1),
        commit_sha: env.COMMIT_SHA,
        run_id: Number(env.GITHUB_RUN_ID),
        run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
        packages: {
            "open-vsx": {
                artifact_name: env.PUBLIC_ARTIFACT,
                asset_name: env.PUBLIC_ASSET,
                sha256: env.PUBLIC_SHA256,
            },
            "vscode-marketplace": {
                artifact_name: env.MARKETPLACE_ARTIFACT,
                asset_name: env.MARKETPLACE_ASSET,
                sha256: env.MARKETPLACE_SHA256,
            },
        },
    }
    return assertTestEvidence(evidence, {
        tag: env.RELEASE_TAG,
        sha: env.COMMIT_SHA,
        id: Number(env.GITHUB_RUN_ID),
        attempt: Number(env.GITHUB_RUN_ATTEMPT),
    })
}

function githubPages(repository, endpoint) {
    return JSON.parse(
        execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repository}/${endpoint}`], {
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "inherit"],
        }),
    )
}

function writeOutputs(env, outputs) {
    appendFileSync(
        env.GITHUB_OUTPUT,
        Object.entries(outputs)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(""),
    )
}

async function main(env, mode, filename) {
    if (mode === "record") {
        writeFileSync(filename, `${JSON.stringify(createTestEvidence(env), null, 2)}\n`)
        return
    }
    if (mode === "verify") {
        const evidence = assertTestEvidence(JSON.parse(readFileSync(filename, "utf8")), {
            sha: env.COMMIT_SHA,
            tag: env.RELEASE_TAG,
            id: Number(env.TESTS_RUN_ID),
            attempt: Number(env.TESTS_RUN_ATTEMPT),
        })
        const pub = evidence.packages["open-vsx"]
        const marketplace = evidence.packages["vscode-marketplace"]
        writeOutputs(env, {
            tag: evidence.tag,
            version: evidence.version,
            commit_sha: evidence.commit_sha,
            artifact_name: pub.artifact_name,
            asset_name: pub.asset_name,
            sha256: pub.sha256,
            marketplace_artifact_name: marketplace.artifact_name,
            marketplace_asset_name: marketplace.asset_name,
            marketplace_sha256: marketplace.sha256,
        })
        return
    }
    const repository = env.GITHUB_REPOSITORY
    if (
        mode !== "wait" ||
        !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
        !SHA.test(env.GITHUB_SHA ?? "") ||
        env.GITHUB_EVENT_NAME !== "push" ||
        env.GITHUB_REF !== `refs/tags/${env.GITHUB_REF_NAME}`
    )
        throw new Error("Automatic publication requires this repository's exact production tag push.")
    const context = { repository, sha: env.GITHUB_SHA, tag: env.GITHUB_REF_NAME }
    const verify = () =>
        assertTagHead({
            ...context,
            main: githubPages(repository, "git/ref/heads/main")[0].object.sha,
            tagged: githubPages(repository, `commits/${encodeURIComponent(context.tag)}`)[0].sha,
        })
    verify()
    const gate = await awaitTagTests(context, {
        listRuns: () =>
            githubPages(
                repository,
                `actions/workflows/test-main.yml/runs?event=push&head_sha=${context.sha}&per_page=100`,
            ).flatMap((page) => page.workflow_runs),
        listJobs: ({ id, attempt }) =>
            githubPages(repository, `actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`).flatMap((page) => page.jobs),
        pause: () => setTimeout(30_000),
    })
    verify()
    writeOutputs(env, {
        tests_run_id: gate.id,
        tests_run_attempt: gate.attempt,
        evidence_artifact: `production-test-evidence-${context.sha}-${gate.attempt}`,
    })
    console.log(`Publishing artifacts from tagged Main Tests ${gate.id}, attempt ${gate.attempt}; no tests were started.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.env, process.argv[2], process.argv[3]).catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
}
