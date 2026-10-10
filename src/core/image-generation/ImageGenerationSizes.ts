import { GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "@shared/image-generation"
import type { ImageGenerationSize } from "./contracts"
import { ImageGenerationError } from "./contracts"

export interface ImageGenerationSizePreset {
    readonly id: string
    readonly label: string
    readonly size: ImageGenerationSize
}

export const DEFAULT_IMAGE_GENERATION_SIZE: ImageGenerationSize = Object.freeze({ width: 2048, height: 1152 })

interface OpenAISubscriptionImagePreset {
    readonly ratio: number
    readonly promptPhrase: string
    readonly expectedOutputSize: ImageGenerationSize
}

const OPENAI_SUBSCRIPTION_IMAGE_PRESETS: readonly OpenAISubscriptionImagePreset[] = Object.freeze([
    { ratio: 16 / 9, promptPhrase: "横版 16:9", expectedOutputSize: Object.freeze({ width: 1672, height: 941 }) },
    { ratio: 9 / 16, promptPhrase: "竖屏 9:16", expectedOutputSize: Object.freeze({ width: 941, height: 1672 }) },
    { ratio: 4 / 3, promptPhrase: "4:3", expectedOutputSize: Object.freeze({ width: 1448, height: 1086 }) },
    { ratio: 3 / 4, promptPhrase: "3:4", expectedOutputSize: Object.freeze({ width: 1086, height: 1448 }) },
    { ratio: 3 / 2, promptPhrase: "3:2 尺寸", expectedOutputSize: Object.freeze({ width: 1536, height: 1024 }) },
    { ratio: 2 / 3, promptPhrase: "2:3 尺寸", expectedOutputSize: Object.freeze({ width: 1024, height: 1536 }) },
    { ratio: 2 / 5, promptPhrase: "2:5 竖屏", expectedOutputSize: Object.freeze({ width: 793, height: 1983 }) },
    { ratio: 5 / 2, promptPhrase: "5:2 横屏", expectedOutputSize: Object.freeze({ width: 1983, height: 793 }) },
])

const SUBSCRIPTION_ASPECT_RATIO_TOLERANCE = 0.02

/** Common output sizes that also satisfy GPT Image 2 custom-size constraints. */
export const IMAGE_GENERATION_SIZE_PRESETS: readonly ImageGenerationSizePreset[] = Object.freeze([
    { id: "2k-landscape", label: "2K Landscape (2048×1152)", size: Object.freeze({ width: 2048, height: 1152 }) },
    { id: "near-full-hd", label: "Near Full HD (1920×1088)", size: Object.freeze({ width: 1920, height: 1088 }) },
    { id: "hd-landscape", label: "HD Landscape (1280×720)", size: Object.freeze({ width: 1280, height: 720 }) },
    { id: "classic-4-3", label: "Classic 4:3 (1024×768)", size: Object.freeze({ width: 1024, height: 768 }) },
    { id: "square", label: "Square (1024×1024)", size: Object.freeze({ width: 1024, height: 1024 }) },
])

const GPT_IMAGE_2_MIN_EDGE = 16
const GPT_IMAGE_2_MAX_EDGE = 3840
const GPT_IMAGE_2_MIN_PIXELS = 655_360
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400
const GPT_IMAGE_2_MAX_ASPECT_RATIO = 3
const GPT_IMAGE_2_EDGE_MULTIPLE = 16

function invalidGptImage2Size(size: ImageGenerationSize): boolean {
    const { width, height } = size
    const pixels = width * height
    return (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < GPT_IMAGE_2_MIN_EDGE ||
        height < GPT_IMAGE_2_MIN_EDGE ||
        width > GPT_IMAGE_2_MAX_EDGE ||
        height > GPT_IMAGE_2_MAX_EDGE ||
        width % GPT_IMAGE_2_EDGE_MULTIPLE !== 0 ||
        height % GPT_IMAGE_2_EDGE_MULTIPLE !== 0 ||
        Math.max(width / height, height / width) > GPT_IMAGE_2_MAX_ASPECT_RATIO ||
        pixels < GPT_IMAGE_2_MIN_PIXELS ||
        pixels > GPT_IMAGE_2_MAX_PIXELS
    )
}

function requestedRatio(size: ImageGenerationSize, aspectRatio?: string): number {
    const match = aspectRatio?.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/)
    if (!match) return size.width / size.height
    const width = Number(match[1])
    const height = Number(match[2])
    return width > 0 && height > 0 ? width / height : size.width / size.height
}

function resolveOpenAISubscriptionPreset(size: ImageGenerationSize, aspectRatio?: string): OpenAISubscriptionImagePreset {
    const ratio = requestedRatio(size, aspectRatio)
    const preset = OPENAI_SUBSCRIPTION_IMAGE_PRESETS.find(
        (candidate) => Math.abs(candidate.ratio - ratio) / candidate.ratio <= SUBSCRIPTION_ASPECT_RATIO_TOLERANCE,
    )
    if (preset) return preset
    throw new ImageGenerationError({
        code: "size_limit_exceeded",
        message: "GPT Image 2 subscription mode supports 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:5, or 5:2 output ratios.",
        retryable: false,
    })
}

export function resolveOpenAISubscriptionImagePrompt(
    prompt: string,
    requestedSize: ImageGenerationSize = DEFAULT_IMAGE_GENERATION_SIZE,
    aspectRatio?: string,
): { prompt: string; expectedOutputSize: ImageGenerationSize } {
    const preset = resolveOpenAISubscriptionPreset(requestedSize, aspectRatio)
    return {
        prompt: `${prompt}\n\n${preset.promptPhrase}`,
        expectedOutputSize: preset.expectedOutputSize,
    }
}

function resolveGptImage1Size(requestedSize?: ImageGenerationSize): string {
    const size = requestedSize ?? DEFAULT_IMAGE_GENERATION_SIZE
    if (size.width === size.height) return "1024x1024"
    return size.width > size.height ? "1536x1024" : "1024x1536"
}

/** Resolve the exact Images/Responses size string for an OpenAI image model. */
export function resolveOpenAIImageSize(modelId: string, requestedSize?: ImageGenerationSize): string | undefined {
    if (modelId === GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID) return undefined
    if (modelId === "gpt-image-1") return resolveGptImage1Size(requestedSize)
    if (modelId !== "gpt-image-2") {
        return requestedSize ? `${requestedSize.width}x${requestedSize.height}` : undefined
    }
    const size = requestedSize ?? DEFAULT_IMAGE_GENERATION_SIZE
    if (invalidGptImage2Size(size)) {
        throw new ImageGenerationError({
            code: "size_limit_exceeded",
            message:
                "GPT Image 2 dimensions must be multiples of 16, no more than 3840 pixels per edge, use an aspect ratio from 1:3 to 3:1, and contain 655,360 to 8,294,400 pixels.",
            retryable: false,
        })
    }
    return `${size.width}x${size.height}`
}
