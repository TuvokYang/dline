/** Preserve each domain's keys and named arguments without depending on the assembled catalog. */
export type UiResource<T> = {
    readonly [K in keyof T]: T[K] extends (...args: infer Args) => string ? (...args: Args) => string : string
}
