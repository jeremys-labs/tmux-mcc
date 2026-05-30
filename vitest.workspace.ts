import { defineWorkspace } from 'vitest/config';

// Delegates to each package's own vite/vitest config so that
// `npx vitest run` from the repo root uses the correct plugins
// (e.g. @vitejs/plugin-react for JSX transform in the client package).
export default defineWorkspace([
  'packages/client',
  'packages/server',
]);
