import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { proveEvidenceEdge } from "../lib/checks-code-conformance.mjs"
import { buildDependencyClosure } from "../lib/tree-sitter-dependencies.mjs"

async function proof(t, files, edge) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dline-script-wiring-"))
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
    for (const [file, source] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true })
        fs.writeFileSync(path.join(repoRoot, file), source)
    }
    const closure = await buildDependencyClosure({ repoRoot, seeds: Object.keys(files) })
    const codeSnapshot = {
        ...closure,
        imports: closure.imports.map((entry) => ({ ...entry, typeOnly: entry.classification === "type" })),
        protoServices: [],
    }
    return proveEvidenceEdge({ edge, codeSnapshot, presentArtifacts: new Set(Object.keys(files)) })
}

const propsEdge = {
    kind: "injected_port",
    emit: { path: "mount.tsx" },
    receive: { path: "control.tsx", symbol: "Control" },
    contract: { path: "control.tsx", symbol: "Props" },
}
const control = `export interface Props { enabled: boolean; onChange: (enabled: boolean) => void }
export default function Control({ enabled, onChange }: Props) { return <button disabled={!enabled} onClick={() => onChange(false)} /> }`

test("proves JSX props injection through the imported component and its actual parameter contract", async (t) => {
    const result = await proof(
        t,
        {
            "control.tsx": control,
            "mount.tsx":
                'import Control from "./control"; const save = (enabled: boolean) => {}; export const Mount = () => <Control enabled={true} onChange={save} />',
        },
        propsEdge,
    )
    assert.equal(result.status, "proven")
    assert.equal(result.adapter, "typescript-jsx-props")
})

test("resolves an injected callback to its imported implementation and refuses shadowed or missing bindings", async (t) => {
    const files = {
        "control.tsx": control,
        "save.ts": "export const save = (value: boolean) => value",
        "mount.tsx":
            'import Control from "./control"; import { save } from "./save"; export const Mount = () => <Control enabled={true} onChange={save} />',
    }
    assert.equal((await proof(t, files, propsEdge)).status, "proven")
    assert.notEqual((await proof(t, { ...files, "save.ts": "export const notSave = 1" }, propsEdge)).status, "proven")
    assert.notEqual(
        (
            await proof(
                t,
                {
                    ...files,
                    "mount.tsx":
                        'import Control from "./control"; import { save } from "./save"; export function Mount(save: any) { return <Control enabled={true} onChange={save} /> }',
                },
                propsEdge,
            )
        ).status,
        "proven",
    )
    assert.notEqual(
        (await proof(t, files, { ...propsEdge, emit: { path: "mount.tsx", symbol: "Disconnected" } })).status,
        "proven",
    )
    assert.notEqual(
        (
            await proof(
                t,
                { ...files, "control.tsx": control.replace("() => onChange(false)", "(onChange: any) => onChange(false)") },
                propsEdge,
            )
        ).status,
        "proven",
    )
    assert.notEqual(
        (
            await proof(
                t,
                {
                    ...files,
                    "mount.tsx":
                        'import Control from "./control"; let save: any = () => {}; save = 1; export const Mount = () => <Control enabled={true} onChange={save} />',
                },
                propsEdge,
            )
        ).status,
        "proven",
    )
})

test("rejects missing callback, wrong contract, disconnected mount, and a shadow component", async (t) => {
    const mutations = [
        ['import Control from "./control"; export const Mount = () => <Control enabled={true} />', propsEdge],
        [
            'import Control from "./control"; export const Mount = () => <Control enabled={true} onChange={save} />',
            { ...propsEdge, contract: { path: "control.tsx", symbol: "Other" } },
        ],
        ['import Control from "./control"; export const Mount = () => null', propsEdge],
        [
            'import Control from "./control"; export function Mount(Control: any) { return <Control enabled={true} onChange={save} /> }',
            propsEdge,
        ],
    ]
    for (const [mount, edge] of mutations)
        assert.notEqual((await proof(t, { "control.tsx": control, "mount.tsx": mount }, edge)).status, "proven")
})

test("does not infer event delivery from a same-name method on a different concrete receiver", async (t) => {
    const edge = {
        kind: "event",
        emit: { path: "send.ts", symbol: "send" },
        receive: { path: "runtime.ts", symbol: "Runtime" },
        contract: { path: "event.ts", symbol: "Event" },
    }
    const files = {
        "event.ts": 'export interface Event { type: "ready" }',
        "runtime.ts": 'import type { Event } from "./event"; export class Runtime { submit(event: Event) {} }',
        "send.ts":
            'import { Runtime } from "./runtime"; import type { Event } from "./event"; export function send(event: Event) { const runtime = new Runtime(); return runtime.submit(event) }',
    }
    assert.equal((await proof(t, files, edge)).status, "proven")
    assert.notEqual(
        (await proof(t, { ...files, "send.ts": files["send.ts"].replace("new Runtime()", "new Other()") }, edge)).status,
        "proven",
    )
    assert.notEqual(
        (await proof(t, { ...files, "runtime.ts": "export class Runtime { submit(event: string) {} }" }, edge)).status,
        "proven",
    )
    assert.notEqual(
        (
            await proof(
                t,
                {
                    ...files,
                    "send.ts":
                        'import { Runtime } from "./runtime"; import type { Event } from "./event"; export function send(event: Event) { const runtime = new Runtime(); function disconnected(runtime: any, event: any) { return runtime.submit(event) } }',
                },
                edge,
            )
        ).status,
        "proven",
    )
    assert.notEqual(
        (
            await proof(
                t,
                {
                    ...files,
                    "send.ts": files["send.ts"].replace(
                        "return runtime.submit(event)",
                        "runtime.submit = () => {}; return runtime.submit(event)",
                    ),
                },
                edge,
            )
        ).status,
        "proven",
    )
})

test("JSX injection requires a reachable mount and registered callback rather than dead occurrences", async (t) => {
    const edge = { ...propsEdge, emit: { path: "mount.tsx", symbol: "Mount" } }
    const files = { "control.tsx": control, "save.ts": "export const save = (value: boolean) => value" }
    for (const body of [
        "return null; return <Control enabled={true} onChange={save} />",
        "const unused = () => <Control enabled={true} onChange={save} />; return null",
        "function Control(props: any) { return null } return <Control enabled={true} onChange={save} />",
    ])
        assert.notEqual(
            (
                await proof(
                    t,
                    {
                        ...files,
                        "mount.tsx": `import Control from "./control"; import { save } from "./save"; export function Mount() { ${body} }`,
                    },
                    edge,
                )
            ).status,
            "proven",
        )
    const mounted =
        'import Control from "./control"; import { save } from "./save"; export const Mount = () => <Control enabled={true} onChange={save} />'
    for (const body of ["const never = () => onChange(enabled); return null", "if (false) onChange(enabled); return null"]) {
        assert.notEqual(
            (
                await proof(
                    t,
                    {
                        ...files,
                        "mount.tsx": mounted,
                        "control.tsx": `export interface Props { enabled: boolean; onChange: (enabled: boolean) => void } export default function Control({enabled, onChange}: Props) { ${body} }`,
                    },
                    edge,
                )
            ).status,
            "proven",
        )
    }
})

test("event certificates reject unmodelled control, mutation, receiver and settlement effects", async (t) => {
    const edge = {
        kind: "event",
        emit: { path: "send.ts", symbol: "send" },
        receive: { path: "runtime.ts", symbol: "Runtime" },
        contract: { path: "event.ts", symbol: "Event" },
    }
    const base = {
        "event.ts": 'export interface Event { type: "ready" }',
        "runtime.ts": 'import type { Event } from "./event"; export class Runtime { submit(event: Event) {} }',
    }
    const examples = [
        ["pending then", "return new Promise(() => {}).then(() => runtime.submit(event))"],
        ["rejected then", "return new Promise((resolve, reject) => reject(0)).then(() => runtime.submit(event))"],
        ["pending await", "await new Promise(() => {}); return runtime.submit(event)"],
        ["pending allSettled", "return Promise.allSettled([new Promise(() => {})]).then(() => runtime.submit(event))"],
        ["called throw", 'function stop() { throw new Error("stop") } stop(); return runtime.submit(event)'],
        ["finally return", "try {} finally { return } return runtime.submit(event)"],
        ["switch return", "switch (1) { case 1: return } return runtime.submit(event)"],
        ["nonterminating loop", "while (true) {} return runtime.submit(event)"],
        ["loose comparison", 'if ("0" == 0) return; return runtime.submit(event)'],
        ["inconsistent branch", "if (flag) { if (!flag) return runtime.submit(event) }"],
        ["container mutation", "const holder = {runtime}; holder.runtime.submit = () => {}; return runtime.submit(event)"],
        ["assigned alias", "let alias; alias = runtime; alias.submit = () => {}; return runtime.submit(event)"],
        ["parameter mutation", "function replace(x: any) { x.submit = () => {} } replace(runtime); return runtime.submit(event)"],
        [
            "constructor shadow",
            "class Other { submit(event: Event) {} } const deliver = Runtime => { const r = new Runtime(); return r.submit(event) }; return deliver(Other)",
        ],
        [
            "unbound method",
            "class Bridge { constructor(private readonly target: Runtime) {} route(event: Event) { return this.target.submit(event) } } const bridge = new Bridge(runtime); const route = bridge.route; return route(event)",
        ],
    ]
    for (const [name, body] of examples)
        await t.test(name, async (t) => {
            const files = {
                ...base,
                "send.ts": `import { Runtime } from "./runtime"; import type { Event } from "./event"; export async function send(event: Event, flag: boolean) { const runtime = new Runtime(); ${body} }`,
            }
            assert.notEqual((await proof(t, files, edge)).status, "proven")
        })
    await t.test("throwing constructor", async (t) => {
        const files = {
            ...base,
            "runtime.ts": base["runtime.ts"].replace("submit(event:", 'constructor() { throw new Error("never") } submit(event:'),
            "send.ts":
                'import { Runtime } from "./runtime"; import type { Event } from "./event"; export function send(event: Event) { const runtime = new Runtime(); return runtime.submit(event) }',
        }
        assert.notEqual((await proof(t, files, edge)).status, "proven")
    })
})

test("event certificates reject disconnected calls and constructor replacement", async (t) => {
    const edge = {
        kind: "event",
        emit: { path: "send.ts", symbol: "send" },
        receive: { path: "runtime.ts", symbol: "Runtime" },
        contract: { path: "event.ts", symbol: "Event" },
    }
    const base = {
        "event.ts": 'export interface Event { type: "ready" }',
        "runtime.ts": 'import type { Event } from "./event"; export class Runtime { submit(event: Event) {} }',
    }
    for (const [name, body, runtime] of [
        ["unused closure", "const unused = () => runtime.submit(event)", base["runtime.ts"]],
        ["constant false", "if (false) return runtime.submit(event)", base["runtime.ts"]],
        ["after return", "return; runtime.submit(event)", base["runtime.ts"]],
        [
            "constructor replacement",
            "return runtime.submit(event)",
            base["runtime.ts"].replace("submit(event:", "constructor() { this.submit = () => {} } submit(event:"),
        ],
    ])
        await t.test(name, async (t) => {
            const result = await proof(
                t,
                {
                    ...base,
                    "runtime.ts": runtime,
                    "send.ts": `import { Runtime } from "./runtime"; import type { Event } from "./event"; export function send(event: Event) { const runtime = new Runtime(); ${body} }`,
                },
                edge,
            )
            assert.notEqual(result.status, "proven")
        })
})
