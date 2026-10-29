import { InstanceDatabase, openInstanceStorage } from "../instance"
import { TrajectoryRowStore } from "./TrajectoryRowStore"

/** The only module that writes `trajectory.db`: the trajectory maintainer of the window that may write the task. */
export const TRAJECTORY_WRITER = "trajectory-projection"

/**
 * Opens the trajectory cache of one instance on behalf of `owner`.
 *
 * Each call gets its own instance storage, closed together with the returned store,
 * so releasing the store also releases the writer claim taken by its first write.
 */
export async function openTrajectoryRows(instanceRoot: string, owner: string = TRAJECTORY_WRITER): Promise<TrajectoryRowStore> {
    const storage = openInstanceStorage(instanceRoot)
    try {
        const database = await storage.openDatabase(InstanceDatabase.Trajectory, owner)
        return await TrajectoryRowStore.open(database, () => storage.close())
    } catch (error) {
        await storage.close().catch(() => undefined)
        throw error
    }
}
