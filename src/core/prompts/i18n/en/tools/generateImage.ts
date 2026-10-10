const prompts: Record<string, string> = {
    standardDescription:
        "Generate or edit images through the configured Current, Independent, or Hosted image source. This is the only AI-callable image generation entry point and is a paid external operation. Choose output size, quality, format, compression, and background explicitly when the user requests them. Outputs are stored as task artifacts; the tool result contains artifact IDs and safe metadata, never full base64 image data.",
    gptImage2SizingDescription:
        "Arbitrary output resolutions are supported. Request dimensions through width and height under these constraints: both edges must be multiples of 16, the longest edge must not exceed 3840 pixels, the long-to-short edge ratio must stay within 3:1, and the total pixel count must be between 655,360 and 8,294,400. Common choices are 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160, and 2160x3840; square images generate fastest and outputs above 2,560x1,440 pixels are experimental. Dimensions outside these constraints are rejected before the request is sent. Omit width and height to use the default 2048x1152 target.",
    gptImage2SubscriptionSizingDescription:
        "Eight output sizes are supported: 1672x941 for 16:9, 941x1672 for 9:16, 1448x1086 for 4:3, 1086x1448 for 3:4, 1536x1024 for 3:2, 1024x1536 for 2:3, 793x1983 for 2:5, and 1983x793 for 5:2. Choose width and height that match one of these ratios, or set aspect_ratio to one of them; a request whose ratio is not within 2 percent of a supported ratio is rejected. Only one image is returned per call, and edit masks are not supported.",
    gptImage1SizingDescription:
        "Three output sizes are supported: 1024x1024 for square, 1536x1024 for landscape, and 1024x1536 for portrait. Choose width and height that match one of these; any other pair is resolved by orientation alone, so equal edges become square, a wider request becomes landscape, and a taller request becomes portrait.",
    promptInstruction: "Describe the image to generate or the edit to apply.",
    profileInstruction: "Optional name or ID of the currently bound Image profile. This cannot switch to unrelated credentials.",
    countInstruction: "Number of images to generate. Must be a positive integer within the model and task limits.",
    widthInstruction:
        "Optional desired output width in pixels. Provide height together with width, and use a value the selected image model actually supports. Omit both to use the default target for the selected model.",
    heightInstruction:
        "Optional desired output height in pixels. Provide width together with height, and use a value the selected image model actually supports. Omit both to use the default target for the selected model.",
    aspectRatioInstruction: "Optional desired aspect ratio. Use a ratio the selected image model actually supports.",
    qualityInstruction: "Optional quality: auto, low, medium, or high. Defaults to auto.",
    backgroundInstruction: "Optional background mode: auto, opaque, or transparent. Transparent output requires PNG or WebP.",
    outputFormatInstruction: "Optional output format: png, jpeg, or webp. Defaults to png.",
    outputCompressionInstruction: "Optional integer compression level from 0 to 100. Only valid for JPEG and WebP output.",
    referenceArtifactIdsInstruction: "Optional JSON array of task image Artifact IDs to use as references.",
    maskArtifactIdInstruction: "Optional task image Artifact ID to use as an edit mask.",
}

export default prompts
