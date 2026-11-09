import type { UiMessage } from "@shared/ExtensionMessage"
import {
    completion,
    failedCommand,
    failedEdit,
    finishedCommand,
    finishedRequest,
    finishedTurnTranscript,
    restorePoint,
    subagentBatch,
    userFeedback,
    workingRespond,
} from "../messages/activityFoldStoryFixtures"

/**
 * A working update precedes execution; a phase report follows its result in a
 * later request.
 *
 * `withFailures` appends a turn whose edit, command and subagent batch all
 * failed, so a story can show the error counts a block reports instead of only
 * successful work.
 */
export function createFoldingTranscript(turnCount: number, withFailures = false): UiMessage[] {
    const turns = Array.from({ length: turnCount }, (_, index) => {
        const offset = 1_000 + index * 100
        const messages = finishedTurnTranscript.map((message) => ({ ...message, ts: offset + message.ts }))
        messages[0] = {
            ...messages[0],
            say: index === 0 ? "task" : "user_feedback",
            text: `Turn ${index + 1}: ${index === 0 ? "Fix the lint step" : "Review the next module and run its checks"}`,
        }
        messages.splice(
            messages.findIndex(({ ts }) => ts === offset + 40),
            0,
            finishedRequest(offset + 35),
            workingRespond(offset + 36, "I have read the relevant files. I will run the lint check now."),
        )
        messages.splice(
            messages.findIndex(({ ts }) => ts === offset + 50),
            0,
            finishedRequest(offset + 43),
            {
                ts: offset + 44,
                type: "say",
                say: "tool",
                text: JSON.stringify({
                    tool: "statusUpdate",
                    content: "The lint check passed. I will check the final diff next.",
                }),
            },
            restorePoint(offset + 45, "files-1"),
            finishedRequest(offset + 46),
            finishedCommand(offset + 47, "git diff --check"),
        )
        return messages
    }).flat()
    return withFailures ? [...turns, ...failedTurn(turnCount)] : turns
}

/** One finished turn whose edit, command and subagent batch all failed. */
function failedTurn(index: number): UiMessage[] {
    const offset = 1_000 + index * 100
    return [
        userFeedback(offset + 1, "Turn with failures: retry the checks that did not pass"),
        restorePoint(offset + 10, "files-failed"),
        finishedRequest(offset + 11),
        failedEdit(offset + 12, "src/broken.ts"),
        failedEdit(offset + 13, "src/also-broken.ts"),
        failedCommand(offset + 14, "npm run test", 2),
        subagentBatch(offset + 15, "failed", 2),
        finishedRequest(offset + 16),
        completion(offset + 17, "Three failures were reported."),
    ]
}
