/**
 * Unit tests for OrchestratorController registry and spawn relations.
 *
 * Covers:
 * - Controller registration / unregistration
 * - getController / getControllerCount
 * - recordSpawn / getSpawnedTaskIds / getParentTaskId
 * - Main controller registration
 * - Singleton reset
 */
import { afterEach, describe, it } from "vitest"
import "should"
import { OrchestratorController } from "../OrchestratorController"

// Minimal mock Controller for testing
function createMockController(): any {
    return { taskId: "mock", dispose: () => {} }
}

describe("OrchestratorController — Registry & Spawn Relations", () => {
    afterEach(() => {
        OrchestratorController.reset()
    })

    describe("initialization", () => {
        it("should initialize and return singleton", () => {
            const instance = OrchestratorController.initialize()
            const instance2 = OrchestratorController.getInstance()
            instance.should.equal(instance2)
        })

        it("should throw if getInstance called before initialize", () => {
            OrchestratorController.reset()
            ;(() => OrchestratorController.getInstance()).should.throw()
        })
    })

    describe("controller registration", () => {
        it("should register a controller and retrieve it by taskId", () => {
            const orchestrator = OrchestratorController.initialize()
            const ctrl = createMockController()
            orchestrator.registerController("task-1", ctrl)
            orchestrator.getController("task-1")?.should.equal(ctrl)
        })

        it("should return undefined for unregistered taskId", () => {
            const orchestrator = OrchestratorController.initialize()
            ;(orchestrator.getController("unknown") === undefined).should.be.true()
        })

        it("should track active controller count", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.registerController("task-1", createMockController())
            orchestrator.registerController("task-2", createMockController())
            orchestrator.getControllerCount().should.equal(2)
        })

        it("returns active controllers as a read-only snapshot", () => {
            const orchestrator = OrchestratorController.initialize()
            const first = createMockController()
            const second = createMockController()

            orchestrator.registerController("task-1", first)
            orchestrator.registerController("task-2", second)

            const active = orchestrator.getActiveControllers()

            active.should.deepEqual([first, second])
            active.length = 0
            orchestrator.getControllerCount().should.equal(2)
        })

        it("should unregister a controller", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.registerController("task-1", createMockController())
            orchestrator.unregisterController("task-1")
            orchestrator.getControllerCount().should.equal(0)
            ;(orchestrator.getController("task-1") === undefined).should.be.true()
        })
    })

    describe("main controller", () => {
        it("should register and retrieve main controller", () => {
            const orchestrator = OrchestratorController.initialize()
            const mainCtrl = createMockController()
            orchestrator.registerMainController(mainCtrl)
            orchestrator.getMainController()?.should.equal(mainCtrl)
        })
    })

    describe("spawn relations", () => {
        it("should record and retrieve spawn relations", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.recordSpawn("parent-1", "child-1")
            orchestrator.recordSpawn("parent-1", "child-2")

            const children = orchestrator.getSpawnedTaskIds("parent-1")
            children.should.deepEqual(["child-1", "child-2"])
        })

        it("should return empty array for unknown parent", () => {
            const orchestrator = OrchestratorController.initialize()
            const children = orchestrator.getSpawnedTaskIds("unknown")
            children.should.deepEqual([])
        })

        it("should find parent taskId from child", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.recordSpawn("parent-1", "child-1")

            orchestrator.getParentTaskId("child-1")?.should.equal("parent-1")
        })

        it("should return undefined for unknown child", () => {
            const orchestrator = OrchestratorController.initialize()
            ;(orchestrator.getParentTaskId("unknown") === undefined).should.be.true()
        })

        it("should clear spawn relations when parent unregisters without active children", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.registerController("parent-1", createMockController())
            orchestrator.recordSpawn("parent-1", "child-1")

            orchestrator.unregisterController("parent-1")
            orchestrator.getSpawnedTaskIds("parent-1").should.deepEqual([])
        })

        it("keeps the child identity when its parent controller closes", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.registerController("parent-1", createMockController())
            orchestrator.registerController("child-1", createMockController())
            orchestrator.recordSpawn("parent-1", "child-1")

            orchestrator.unregisterController("parent-1")

            orchestrator.getParentTaskId("child-1")?.should.equal("parent-1")
        })

        it("removes a closed child from its parent's spawn relation", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.registerController("child-1", createMockController())
            orchestrator.recordSpawn("parent-1", "child-1")

            orchestrator.unregisterController("child-1")

            orchestrator.getSpawnedTaskIds("parent-1").should.deepEqual([])
            ;(orchestrator.getParentTaskId("child-1") === undefined).should.be.true()
        })

        it("returns a spawn relation snapshot that callers cannot mutate", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.recordSpawn("parent-1", "child-1")

            const children = orchestrator.getSpawnedTaskIds("parent-1")
            children.push("injected-child")

            orchestrator.getSpawnedTaskIds("parent-1").should.deepEqual(["child-1"])
        })
    })

    describe("spawnTask — combined register + record", () => {
        it("should register controller and record spawn relation in one call", () => {
            const orchestrator = OrchestratorController.initialize()
            const childCtrl = createMockController()

            const result = orchestrator.spawnTask("child-1", childCtrl, "parent-1")

            // Returns the same childTaskId
            result.should.equal("child-1")
            // Controller is registered
            orchestrator.getController("child-1")?.should.equal(childCtrl)
            // Spawn relation is recorded
            orchestrator.getSpawnedTaskIds("parent-1").should.deepEqual(["child-1"])
            orchestrator.getParentTaskId("child-1")?.should.equal("parent-1")
        })

        it("should increment controller count after spawn", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.spawnTask("child-1", createMockController(), "parent-1")
            orchestrator.spawnTask("child-2", createMockController(), "parent-1")
            orchestrator.getControllerCount().should.equal(2)
        })

        it("should throw when childTaskId is empty", () => {
            const orchestrator = OrchestratorController.initialize()
            ;(() => orchestrator.spawnTask("", createMockController(), "parent-1")).should.throw()
        })

        it("should throw when childController is null", () => {
            const orchestrator = OrchestratorController.initialize()
            ;(() => orchestrator.spawnTask("child-1", null as any, "parent-1")).should.throw()
        })

        it("should throw when parentTaskId is empty", () => {
            const orchestrator = OrchestratorController.initialize()
            ;(() => orchestrator.spawnTask("child-1", createMockController(), "")).should.throw()
        })

        it("should support multiple children from same parent", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.spawnTask("child-1", createMockController(), "parent-1")
            orchestrator.spawnTask("child-2", createMockController(), "parent-1")
            orchestrator.spawnTask("child-3", createMockController(), "parent-1")

            const children = orchestrator.getSpawnedTaskIds("parent-1")
            children.should.deepEqual(["child-1", "child-2", "child-3"])
        })
    })

    describe("deprecated counter methods", () => {
        it("should still accept onPanelCreated/onPanelDisposed without error", () => {
            const orchestrator = OrchestratorController.initialize()
            orchestrator.onPanelCreated()
            orchestrator.onPanelDisposed()
            // No error thrown = pass
        })
    })
})
