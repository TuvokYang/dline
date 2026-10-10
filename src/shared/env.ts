export function envFlagEnabled(value: unknown): boolean {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value === 1
    if (typeof value !== "string") return false

    const normalized = value.trim().toLowerCase()
    return normalized === "true" || normalized === "1"
}
