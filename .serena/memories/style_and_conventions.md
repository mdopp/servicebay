# Code Style and Conventions

## Tech Stack
*   **Language**: TypeScript
*   **Framework**: Next.js 16 (App Router)
*   **Styling**: Tailwind CSS
*   **Icons**: Lucide React
*   **Testing**: Vitest, React Testing Library

## Conventions
*   **Components**: Functional components with hooks.
*   **Imports**: Use `@/` alias for `src/` directory.
*   **Styling**: Utility-first CSS with Tailwind.
*   **State Management**: React `useState`, `useEffect`, Context API (e.g., `ToastProvider`).
*   **Async Operations**: `async/await` pattern.
*   **Error Handling**: `try/catch` blocks with user feedback (Toasts).

## File Structure
*   `src/app/`: Next.js App Router pages and layouts.
*   `src/components/`: Reusable UI components.
*   `src/plugins/`: Dashboard plugins.
*   `src/providers/`: React Context providers.
*   `src/lib/`: Utility functions.
*   `server.ts`: Custom server entry point.
