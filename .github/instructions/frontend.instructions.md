---
applyTo: "{**/*.tsx,src/components/**/*.ts,src/app/**/*.tsx}"
---

# ServiceBay Frontend Instructions

You are working on the **ServiceBay** frontend (Next.js 16 + Tailwind CSS).

## UI/UX Rules
1.  **Dark Mode**: All components MUST support dark mode.
    -   Use `dark:` modifiers for all colors (e.g., `bg-white dark:bg-gray-900`).
    -   Ensure text contrast is sufficient in both modes.
2.  **Icons**: Use `lucide-react` for all icons.
    -   Import individual icons: `import { Box } from 'lucide-react'`.
3.  **Notifications**: Use the `useToast` hook.
    -   Pattern: `addToast('loading', ...)` -> `updateToast(id, 'success'|'error', ...)`.
    -   Do not use raw `alert()` or `console.log()` for user feedback.

## Testing
-   **Methodology**: Use **Vitest** + **React Testing Library (RTL)**.
-   **Location**: `tests/frontend/`.
-   **Strategy ("Integration over Implementation")**:
    -   **DO TEST**: What the user sees (Text, Badges) and does (Clicks, Inputs).
    -   **DO NOT TEST**: Internal component state or 3rd party implementations.
    -   **Mocking**: Use `vi.mock('@/hooks/useDigitalTwin', ...)` to inject strict data scenarios (e.g. "Mock Nginx with 2 verified domains"). Do NOT make real API calls.
-   **Verification**: Ensure components render with the mocked data and handle empty states gracefully (e.g. "No services found").
