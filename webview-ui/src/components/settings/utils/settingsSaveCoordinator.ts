export interface SettingsSaveOperations {
    flushInputs(): Promise<void>
    flushRequests(): Promise<void>
    flushProfileCatalog(): Promise<void>
    flushBackend(): Promise<unknown>
    close(): void | Promise<void>
}

/** Complete every Settings persistence boundary before closing the view. */
export async function saveSettingsAndClose(operations: SettingsSaveOperations): Promise<void> {
    await operations.flushInputs()
    await operations.flushRequests()
    await operations.flushProfileCatalog()
    await operations.flushBackend()
    await operations.close()
}
