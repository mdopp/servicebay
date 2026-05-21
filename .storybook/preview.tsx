import type { Preview } from '@storybook/nextjs';
import { initialize, mswLoader } from 'msw-storybook-addon';

// Load the same global CSS Next.js loads. Tailwind utilities, dark-
// mode tokens, and any custom CSS variables are defined here.
import '../src/app/globals.css';

// Boot MSW for Storybook. The handlers come from the same
// packages/frontend/src/mocks/handlers.ts the FE-only dev mode
// uses, so a fixture change shows up in both Storybook and
// `npm run dev:frontend` simultaneously.
initialize({
  onUnhandledRequest: 'bypass',
  serviceWorker: {
    url: '/mockServiceWorker.js',
  },
});

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#0f1115' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    nextjs: {
      // Stories don't need real App Router routing — `appDirectory`
      // tells Storybook to use the App Router mocks so hooks like
      // `useRouter` / `usePathname` return predictable values.
      appDirectory: true,
    },
  },
  loaders: [mswLoader],
};

export default preview;
