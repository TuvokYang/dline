# Storybook Documentation

## What is Storybook?

Storybook is a frontend workshop for building UI components and pages in isolation. It allows developers to:

- **Develop components independently** from the main application
- **Test different states and props** without complex setup
- **Document component APIs** with interactive examples
- **Catch UI bugs** through visual testing
- **Share components** with team members and stakeholders

In Dline's webview, Storybook helps us develop and test React components that make up the chat interface, settings panels, and other UI elements in isolation from the VS Code extension environment.

## Getting Started

### Starting Storybook

To launch the Storybook development server:

```bash
npm run storybook
```

This will start Storybook on `http://localhost:6006` where you can browse all available stories and interact with components.

### Project Structure

```
webview-ui/.storybook/
├── main.ts          # Main configuration
├── preview.ts       # Global decorators and parameters
├── themes.ts        # VSCode theme definitions
└── README.md        # This documentation
```

## Configuration Overview

### Main Configuration (`main.ts`)

- **Stories Location**: Automatically discovers `*.stories.*` files in `../src/`
- **Framework**: Uses `@storybook/react-vite` for React + Vite integration
- **Environment Variables**: Sets development flags (`IS_DEV`, `IS_TEST`, `TEMP_PROFILE`)
- **TypeScript**: Enables type checking and automatic prop documentation

### Preview Configuration (`preview.ts`)

- **Viewport**: Configured for "Editor Sidebar" (700x800px) to match VSCode's sidebar
- **Themes**: VSCode Dark/Light theme switcher in toolbar
- **Global Decorator**: `StorybookWebview` provides VSCode-like environment
- **Documentation**: Dark theme styling to match VSCode

### Theme System (`themes.ts`)

Provides mock VSCode CSS variables for both dark and light themes, ensuring components render correctly outside the VSCode environment.

## Creating Stories

### Basic Story Structure

Create a `*.stories.tsx` file alongside your component:

```typescript
import type { Meta, StoryObj } from "@storybook/react-vite"
import { MyComponent } from "./MyComponent"

const meta: Meta<typeof MyComponent> = {
  title: "Components/MyComponent",
  component: MyComponent,
  parameters: {
    docs: {
      description: {
        component: "Description of what this component does"
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof MyComponent>

export const Default: Story = {
  args: {
    prop1: "value1",
    prop2: true
  }
}

export const WithDifferentState: Story = {
  args: {
    prop1: "different value",
    prop2: false
  }
}
```

### Advanced Story Patterns

For complex components requiring context or state, use the shared typed decorators and fixtures rather than assembling a partial context object manually:

```typescript
import { createStorybookDecorator } from "@/config/StorybookDecorator"

export const WithMockState: Story = {
  decorators: [
    createStorybookDecorator({
      clineMessages: mockMessages,
    }),
  ],
}
```

`Views/Chat` stories use `createChatStoryState` from `src/config/storybook/chatStoryFixtures.ts`. An active task fixture must keep `taskTitleMessage`, `currentTaskItem`, `taskViewState`, `clineMessages`, and message-window counts consistent. Do not put the task title back into the body message window or bypass the contract with `any`.

### Story Organization

- **Title**: Use hierarchical naming like `"Views/Chat"` or `"Components/Button"`
- **Parameters**: Add descriptions and documentation
- **Args**: Define default props for interactive controls
- **Multiple Stories**: Show different states, props, or use cases

## Writing UI Tests

### Automated Storybook Render Tests

Run the executable Chat rendering suite from the repository root:

```bash
npx playwright test -c playwright.storybook.config.ts
```

The Playwright config starts Storybook automatically, opens stories through their direct iframe URLs, and verifies that active Chat stories do not fall back to the Welcome state. It also checks representative interaction actions and timeline-card content. The suite currently covers all active `Views/Chat` stories.

`play` functions remain useful for story-local interaction examples, but a `test` tag or `play` function alone is not a CI result. Rendering regressions must be covered by the Playwright suite or another explicitly executed test command.

### Interactive Testing with `play` Functions

Storybook supports automated interaction testing using the `play` function:

```typescript
import { expect, userEvent, within } from "storybook/test"

export const InteractiveTest: Story = {
  args: {
    // Component props
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    
    // Find elements
    const button = canvas.getByText("Click me")
    const input = canvas.getByPlaceholderText("Enter text")
    
    // Perform interactions
    await userEvent.type(input, "Hello world")
    await userEvent.click(button)
    
    // Assert results
    await expect(canvas.getByText("Hello world")).toBeInTheDocument()
  }
}
```

### Testing Patterns

1. **User Interactions**: Click buttons, type in inputs, navigate
2. **State Changes**: Verify component updates after interactions
3. **Accessibility**: Test keyboard navigation and screen reader support
4. **Error States**: Test error handling and edge cases

### Example from App.stories.tsx

The `WelcomeScreen` story demonstrates comprehensive testing:

```typescript
export const WelcomeScreen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    
    // Test initial state
    const getStartedButton = canvas.getByText("Get Started for Free")
    const byokButton = canvas.getByText("Use your own API key")
    await expect(getStartedButton).toBeInTheDocument()
    await expect(byokButton).toBeInTheDocument()
    
    // Test interaction
    await userEvent.click(byokButton)
    
    // Test state change
    await expect(getStartedButton).toBeInTheDocument()
    await expect(byokButton).not.toBeInTheDocument()
  }
}
```

## Best Practices

### Story Development

1. **Start Simple**: Create basic stories first, then add complexity
2. **Cover Edge Cases**: Include error states, loading states, empty states
3. **Use Real Data**: Mock realistic data for better testing
4. **Document Behavior**: Add descriptions explaining component purpose

### Testing Guidelines

1. **Test User Flows**: Focus on how users interact with components
2. **Verify Accessibility**: Ensure components work with keyboard and screen readers
3. **Test Responsive Behavior**: Use different viewport sizes
4. **Mock External Dependencies**: Use mocks for API calls and file operations
5. **Keep State Coherent**: Active Chat fixtures must project the task header and interaction state together
6. **Assert the Branch**: Active stories should verify `Type a message...` is present and the Welcome task input is absent

### Performance Tips

1. **Lazy Load Stories**: Use dynamic imports for large story files
2. **Optimize Mock Data**: Keep mock data minimal but realistic
3. **Reuse Decorators**: Create shared decorators for common patterns
4. **Clean Up**: Dispose of resources in story cleanup

## VSCode Integration

### Theme Switching

Use the theme switcher in Storybook's toolbar to test components in both VSCode Dark and Light themes.

### Viewport Testing

The default "Editor Sidebar" viewport (700x800px) matches VSCode's sidebar dimensions, ensuring components render correctly in the actual extension environment.

### Extension Context

The `StorybookWebview` decorator provides a VSCode-like environment with proper CSS variables and context providers, making stories behave similarly to the real extension.

## Troubleshooting

### Common Issues

1. **Missing CSS Variables**: Ensure `StorybookWebview` decorator is applied
2. **Context Errors**: Wrap stories with appropriate context providers
3. **Import Errors**: Check that all dependencies are available in Storybook environment
4. **Theme Issues**: Verify theme CSS variables are properly applied

### Debugging Tips

1. **Use Browser DevTools**: Inspect elements and check console for errors
2. **Check Story Args**: Verify component props are passed correctly
3. **Test in Isolation**: Create minimal stories to isolate issues
4. **Review Configuration**: Check `main.ts` and `preview.ts` for configuration issues

## Resources

- [Storybook Documentation](https://storybook.js.org/docs)
- [Testing with Storybook](https://storybook.js.org/docs/writing-tests)
- [React Storybook Guide](https://storybook.js.org/docs/get-started/react-vite)
