import { SYSTEM_SECTION_IDS, type SystemSectionId } from "../templates/system-template-registry"

export type SystemSectionBodies = Readonly<Partial<Record<SystemSectionId, string>>>
export type SystemSectionSet = ReadonlyMap<SystemSectionId, string>

function createSectionSet(bodies: SystemSectionBodies): SystemSectionSet {
    return new Map(SYSTEM_SECTION_IDS.map((sectionId) => [sectionId, bodies[sectionId] ?? ""]))
}

export function createStandardSectionSet(bodies: SystemSectionBodies): SystemSectionSet {
    return createSectionSet(bodies)
}

export function createLiteSectionSet(overrides: SystemSectionBodies): SystemSectionSet {
    return createSectionSet(overrides)
}
