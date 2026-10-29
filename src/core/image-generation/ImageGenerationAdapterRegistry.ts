import type { ImageGenerationAdapter, ImageGenerationAdapterConfig, ImageGenerationAdapterFactory } from "./contracts"
import { ImageGenerationError } from "./contracts"

export class ImageGenerationAdapterRegistry {
    private readonly factories = new Map<string, ImageGenerationAdapterFactory>()

    register(adapterId: string, factory: ImageGenerationAdapterFactory): void {
        if (!adapterId.trim()) {
            throw new ImageGenerationError({
                code: "invalid_request",
                message: "Image generation adapter provider ID must not be empty.",
                retryable: false,
            })
        }
        if (this.factories.has(adapterId)) {
            throw new ImageGenerationError({
                code: "adapter_already_registered",
                message: `An image generation adapter is already registered for "${adapterId}".`,
                retryable: false,
            })
        }
        this.factories.set(adapterId, factory)
    }

    has(adapterId: string): boolean {
        return this.factories.has(adapterId)
    }

    create(adapterId: string, config: ImageGenerationAdapterConfig): ImageGenerationAdapter {
        const factory = this.factories.get(adapterId)
        if (!factory) {
            throw new ImageGenerationError({
                code: "adapter_not_found",
                message: `No image generation adapter is registered for "${adapterId}".`,
                retryable: false,
            })
        }
        return factory(config)
    }
}
