const QUERY = "q"
const RESPONSE = "s"
const DEFAULT_TIMEOUT_MS = 60_000

const ID_CHARS = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"

function createId(size = 21) {
    let id = ""
    while (size--) {
        id += ID_CHARS[(Math.random() * 64) | 0]
    }
    return id
}

function identity(_key, value) {
    return value
}

class ReferenceString extends String {}

function reviveReferences(values, seen, object, reviver) {
    const pending = []
    for (const key of Object.keys(object)) {
        const value = object[key]
        if (value instanceof ReferenceString) {
            const referenced = values[value]
            if (typeof referenced === "object" && !seen.has(referenced)) {
                seen.add(referenced)
                object[key] = undefined
                pending.push({ key, args: [values, seen, referenced, reviver] })
            } else {
                object[key] = reviver.call(object, key, referenced)
            }
        } else if (object[key] !== undefined) {
            object[key] = reviver.call(object, key, value)
        }
    }
    for (const item of pending) {
        object[item.key] = reviver.call(object, item.key, reviveReferences(...item.args))
    }
    return object
}

export function deserialize(payload, reviver = identity) {
    const values = JSON.parse(payload, (_key, value) => (typeof value === "string" ? new ReferenceString(value) : value)).map(
        (value) => (value instanceof ReferenceString ? String(value) : value),
    )
    const root = values[0]
    const hydrated = typeof root === "object" && root ? reviveReferences(values, new Set(), root, reviver) : root
    return reviver.call({ "": hydrated }, "", hydrated)
}

function addReference(map, values, value) {
    const ref = new ReferenceString(values.push(value) - 1)
    map.set(value, ref)
    return ref
}

export function serialize(value, replacer = identity, space) {
    const map = new Map()
    const values = []
    const output = []
    let index = +addReference(map, values, replacer.call({ "": value }, "", value))
    let first = !index

    while (index < values.length) {
        first = true
        output[index] = JSON.stringify(values[index++], replace, space)
    }

    return `[${output.join(",")}]`

    function replace(key, currentValue) {
        if (first) {
            first = false
            return currentValue
        }

        const replaced = replacer.call(this, key, currentValue)
        if (replaced === null) {
            return replaced
        }

        if (typeof replaced === "object" || typeof replaced === "string") {
            return map.get(replaced) || addReference(map, values, replaced)
        }

        return replaced
    }
}

function toSerializableError(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        }
    }
    return error
}

export function createBirpcClient({ socket, handlers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const pending = new Map()
    let closed = false

    function send(message) {
        socket.send(serialize(message, (_key, value) => toSerializableError(value)))
    }

    function call(method, ...args) {
        if (closed) {
            return Promise.reject(new Error(`[vitest-ui-rpc] connection is closed, cannot call "${method}"`))
        }

        return new Promise((resolve, reject) => {
            const id = createId()
            const timeoutId =
                timeoutMs >= 0
                    ? setTimeout(() => {
                          pending.delete(id)
                          reject(new Error(`[vitest-ui-rpc] timeout calling "${method}"`))
                      }, timeoutMs)
                    : undefined

            timeoutId?.unref?.()
            pending.set(id, { resolve, reject, timeoutId, method })
            send({ m: method, a: args, i: id, t: QUERY })
        })
    }

    function notify(method, ...args) {
        if (closed) {
            throw new Error(`[vitest-ui-rpc] connection is closed, cannot notify "${method}"`)
        }
        send({ m: method, a: args, t: QUERY })
    }

    async function handleMessage(raw) {
        const message = deserialize(raw)
        if (message.t === QUERY) {
            const handler = handlers[message.m]
            let result
            let error
            try {
                if (!handler) {
                    throw new Error(`[vitest-ui-rpc] handler "${message.m}" not found`)
                }
                result = await handler(...message.a)
            } catch (caught) {
                error = caught
            }

            if (message.i) {
                send(error ? { t: RESPONSE, i: message.i, e: error } : { t: RESPONSE, i: message.i, r: result })
            }
            return
        }

        const entry = pending.get(message.i)
        if (!entry) {
            return
        }

        clearTimeout(entry.timeoutId)
        pending.delete(message.i)
        if (message.e) {
            entry.reject(message.e)
        } else {
            entry.resolve(message.r)
        }
    }

    function close(error) {
        closed = true
        for (const { reject, timeoutId, method } of pending.values()) {
            clearTimeout(timeoutId)
            reject(error || new Error(`[vitest-ui-rpc] connection closed while calling "${method}"`))
        }
        pending.clear()
    }

    socket.addEventListener("message", (event) => {
        handleMessage(String(event.data)).catch((error) => {
            console.error("[vitest-ui-rpc] failed to handle message:", error)
        })
    })
    socket.addEventListener("close", () => close())
    socket.addEventListener("error", () => close(new Error("[vitest-ui-rpc] websocket error")))

    return {
        call,
        notify,
        close,
    }
}
