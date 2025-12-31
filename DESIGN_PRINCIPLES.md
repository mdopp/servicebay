# Frontend Design Principles

ServiceBay follows a set of design principles to ensure a consistent, modern, and user-friendly interface. These guidelines should be adhered to when developing new features or plugins.

## 1. Visual Style

### Color Palette
- **Primary Color**: Blue (`blue-600` for actions, `blue-50` for backgrounds).
- **Neutral Colors**: Slate/Gray scale (`gray-50` to `gray-900`) for structure and text.
- **Semantic Colors**:
  - **Success**: Green (`text-green-600`, `bg-green-50`).
  - **Warning**: Yellow/Amber (`text-yellow-600`, `bg-yellow-50`).
  - **Error/Destructive**: Red (`text-red-600`, `bg-red-50`).
- **Dark Mode**: All components must support dark mode (`dark:` variants). Use `bg-gray-900` for main backgrounds and `border-gray-800` for separators.

### Typography
- **Font Family**: System sans-serif stack (Inter/Roboto style).
- **Monospace**: Used for code snippets, logs, and terminal outputs (`font-mono`).
- **Headings**: Bold, clear hierarchy (`text-xl font-bold` for page titles).

### Iconography
- **Library**: [Lucide React](https://lucide.dev/).
- **Usage**: Use icons to enhance recognition but always pair with text for actions unless space is strictly limited.
- **Size**: Standard size is `18px` or `20px`.

## 2. Layout & Structure

### Dashboard Layout
- **Sidebar**: Collapsible navigation on the left.
- **Main Content**: A card-like container (`bg-white`, `rounded-lg`, `shadow-sm`) that fills the remaining space.
- **Header**: Each view should have a clear header with a title and primary actions (e.g., Refresh, Back).

### Content Organization
- **Lists**: Use divided lists (`divide-y`) for collections of items.
- **Cards**: Use bordered cards for grouping related information.
- **Spacing**: Use consistent padding (`p-4` or `p-6`) and gaps (`gap-4`).

## 3. Interaction Patterns

### Navigation
- **Internal Links**: Use Next.js `Link` component.
- **Drill-down**: For detailed views (logs, terminal), navigate to a dedicated page rather than opening a modal.
- **Back Navigation**: Provide a clear "Back" button in the header for sub-pages.

### Feedback
- **Loading States**: Use `Loader2` (animate-spin) for async operations.
- **Toasts**: Use the `useToast` hook for success/error notifications.
- **Modals**: Use modals for critical confirmations (e.g., Delete) or complex forms that don't require a full page context.

### Buttons
- **Primary**: `bg-blue-600 text-white hover:bg-blue-700`.
- **Secondary/Ghost**: `hover:bg-gray-100 text-gray-700`.
- **Destructive**: `text-red-600 hover:bg-red-50`.
- **Icon Buttons**: Always include a `title` attribute for accessibility.

## 4. Code Best Practices

- **Components**: Build small, reusable components (e.g., `PageHeader`, `StatusBadge`).
- **Tailwind**: Use utility classes directly; avoid `@apply` unless necessary for complex reusable patterns.
- **Responsiveness**: Ensure layouts work on mobile (`< md`) by stacking columns or hiding non-essential elements.
