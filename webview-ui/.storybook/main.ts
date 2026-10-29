import type { StorybookConfig } from "@storybook/react-vite"

const config: StorybookConfig = {
    stories: ["../src/**/*.mdx", "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
    addons: [],
    framework: "@storybook/react-vite",
    viteFinal: async (config) => {
        // Define environment variables for Storybook
        config.define = {
            ...config.define,
            "process.platform": JSON.stringify(process.platform),
            "process.env.IS_DEV": JSON.stringify("true"),
            "process.env.IS_TEST": JSON.stringify("true"),
            "process.env.TEMP_PROFILE": JSON.stringify("true"),
        }

        return config
    },
    typescript: {
        check: true,
        // react-docgen-typescript depends on compiler APIs removed by TypeScript 7.
        reactDocgen: "react-docgen",
    },
}
export default config
