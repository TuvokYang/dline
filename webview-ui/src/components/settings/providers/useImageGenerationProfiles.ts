import { EmptyRequest } from "@shared/proto/dline/common"
import {
	ImageGenerationProfile,
	ImageGenerationProfilesResponse,
	UpdateImageGenerationProfilesRequest,
} from "@shared/proto/dline/profile"
import { useCallback, useEffect, useState } from "react"
import { FileServiceClient } from "../../../services/grpc-client"

function emptyProfile(): ImageGenerationProfile {
	return ImageGenerationProfile.create({
		id: crypto.randomUUID(),
		name: "New Image Profile",
		provider: "openai",
		apiKey: "",
		enabled: true,
		legacyNames: [],
	})
}

export function useImageGenerationProfiles() {
	const [profiles, setProfiles] = useState<ImageGenerationProfile[]>([])
	const [loaded, setLoaded] = useState(false)
	const [error, setError] = useState<Error>()

	const reload = useCallback(async () => {
		try {
			const response: ImageGenerationProfilesResponse = await FileServiceClient.getImageGenerationProfiles(
				EmptyRequest.create({}),
			)
			setProfiles(response.profiles)
			setLoaded(true)
			setError(undefined)
		} catch (caught) {
			setError(caught instanceof Error ? caught : new Error(String(caught)))
		}
	}, [])

	useEffect(() => {
		void reload()
	}, [reload])

	const persist = useCallback(
		(next: ImageGenerationProfile[], clearApiKeyProfileIds: string[] = []) => {
			setProfiles(next)
			void FileServiceClient.updateImageGenerationProfiles(
				UpdateImageGenerationProfilesRequest.create({ profiles: next, clearApiKeyProfileIds }),
			).catch((caught: unknown) => {
				setError(caught instanceof Error ? caught : new Error(String(caught)))
				void reload()
			})
		},
		[reload],
	)

	const addProfile = useCallback(() => persist([...profiles, emptyProfile()]), [persist, profiles])
	const updateProfile = useCallback(
		(id: string, updates: Partial<ImageGenerationProfile>) => {
			const next = profiles.map((profile) => (profile.id === id ? { ...profile, ...updates } : profile))
			persist(next, "apiKey" in updates && updates.apiKey === "" ? [id] : [])
		},
		[persist, profiles],
	)
	const removeProfile = useCallback(
		(id: string) => persist(profiles.filter((profile) => profile.id !== id)),
		[persist, profiles],
	)

	return { profiles, loaded, error, reload, addProfile, updateProfile, removeProfile }
}
