/**
 * A request refused before it reached a provider because the task's Profile cannot serve it.
 *
 * Sending the same request again cannot succeed until the Profile is fixed or
 * switched, so it is never retried automatically; its message names what the
 * user has to change and starts with the "Profile not valid:" prefix the chat
 * uses to recognise a failure a Profile switch resolves.
 */
export class ProfileNotValidError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ProfileNotValidError"
	}
}
