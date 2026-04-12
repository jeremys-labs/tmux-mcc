import { test, expect, type Page } from '@playwright/test';

/**
 * Mock agent config returned by /api/config.
 * Provides two agents (isla, kael) with enough fields to render
 * the dashboard without a real backend.
 */
const MOCK_CONFIG = {
  agents: {
    isla: {
      name: 'Isla',
      role: 'Project Lead',
      emoji: '\u{1F338}',
      color: { from: '#f472b6', to: '#c084fc' },
      channel: 'isla',
      greeting: 'Hello!',
      position: { zone: 'main', x: 200, y: 200 },
      tabs: [{ id: 'tasks', label: 'Tasks', icon: 'list', source: '/api/agents/isla/tasks' }],
    },
    kael: {
      name: 'Kael',
      role: 'Backend Engineer',
      emoji: '\u{1F525}',
      color: { from: '#fb923c', to: '#f97316' },
      channel: 'kael',
      greeting: 'Hey there.',
      position: { zone: 'main', x: 400, y: 300 },
      tabs: [{ id: 'tasks', label: 'Tasks', icon: 'list', source: '/api/agents/kael/tasks' }],
    },
  },
};

/**
 * Intercept /api/config so the dashboard can load without a real backend.
 * Also stub common API routes that the app may call on init.
 */
async function mockApiRoutes(page: Page) {
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_CONFIG),
    }),
  );

  // Stub chat history endpoints to return empty arrays
  await page.route('**/api/chat-history/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
  );

  // Stub SSE stream endpoints so they don't hang
  await page.route('**/api/chat-stream/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: '',
    }),
  );

  // Stub health, standup, channels endpoints
  await page.route('**/api/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', gateway: 'connected' }),
    }),
  );

  await page.route('**/api/standup', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: {} }),
    }),
  );

  await page.route('**/api/channels', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ channels: [], recent: [] }),
    }),
  );

  // Stub any other /api/* call with a 200 empty JSON
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    // Only intercept if not already handled by specific routes above
    if (url.includes('/api/config')) return route.fallback();
    if (url.includes('/api/chat-history/')) return route.fallback();
    if (url.includes('/api/chat-stream/')) return route.fallback();
    if (url.includes('/api/health')) return route.fallback();
    if (url.includes('/api/standup')) return route.fallback();
    if (url.includes('/api/channels')) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe('Dashboard - Page Load', () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
  });

  test('page loads without crashing and shows the title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('OpenClaw Office');
    // The loading state should resolve once the mock config is returned
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });
  });

  test('page does not show an error state', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });
    // No "Error:" text should be visible
    await expect(page.locator('text=/^Error:/')).not.toBeVisible();
  });
});

test.describe('Dashboard - Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });
  });

  test('navigation bar renders with Office, Channels, Files tabs', async ({ page }) => {
    const nav = page.locator('header nav');
    await expect(nav).toBeVisible();

    await expect(nav.getByRole('button', { name: 'office' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'channels' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'files' })).toBeVisible();
  });

  test('Office tab is active by default', async ({ page }) => {
    const officeBtn = page.locator('header nav button', { hasText: 'office' });
    // Active tab has the accent color class
    await expect(officeBtn).toHaveClass(/text-accent/);
  });

  test('clicking Channels tab switches the view', async ({ page }) => {
    const channelsBtn = page.locator('header nav button', { hasText: 'channels' });
    await channelsBtn.click();
    await expect(channelsBtn).toHaveClass(/text-accent/);
    // Office button should no longer be active
    const officeBtn = page.locator('header nav button', { hasText: 'office' });
    await expect(officeBtn).not.toHaveClass(/text-accent/);
  });

  test('clicking Files tab switches the view', async ({ page }) => {
    const filesBtn = page.locator('header nav button', { hasText: 'files' });
    await filesBtn.click();
    await expect(filesBtn).toHaveClass(/text-accent/);
  });
});

test.describe('Dashboard - Agent Panel', () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });
  });

  test('agent panel is closed by default', async ({ page }) => {
    // The side panel aside element should not be present
    const aside = page.locator('aside');
    await expect(aside).not.toBeVisible();
  });

  test('agent panel opens via programmatic store access', async ({ page }) => {
    // Use the dev-mode exposed __uiStore to open the agent panel
    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });

    // The side panel should now be visible
    const aside = page.locator('aside');
    await expect(aside).toBeVisible({ timeout: 3000 });
  });

  test('agent panel shows agent name, emoji, and role', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });

    const aside = page.locator('aside');
    await expect(aside).toBeVisible({ timeout: 3000 });

    // Agent name
    await expect(aside.locator('text=Isla')).toBeVisible();
    // Agent emoji (cherry blossom)
    await expect(aside.locator('text=\u{1F338}')).toBeVisible();
    // Agent role
    await expect(aside.locator('text=Project Lead')).toBeVisible();
  });

  test('agent panel has a close button that works', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });

    const aside = page.locator('aside');
    await expect(aside).toBeVisible({ timeout: 3000 });

    const closeBtn = aside.getByRole('button', { name: 'Close' });
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();

    await expect(aside).not.toBeVisible();
  });

  test('switching agents updates panel content', async ({ page }) => {
    // Open panel for isla
    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });

    const aside = page.locator('aside');
    await expect(aside.locator('text=Isla')).toBeVisible({ timeout: 3000 });

    // Switch to kael
    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('kael');
    });

    await expect(aside.locator('text=Kael')).toBeVisible({ timeout: 3000 });
    await expect(aside.locator('text=Backend Engineer')).toBeVisible();
  });
});

test.describe('Dashboard - Chat Panel', () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });
    // Open the agent panel to reveal the chat
    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });
    await expect(page.locator('aside')).toBeVisible({ timeout: 3000 });
  });

  test('chat input field is present with placeholder', async ({ page }) => {
    const textarea = page.locator('aside textarea');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveAttribute('placeholder', /Message Isla/);
  });

  test('send button is present and labeled', async ({ page }) => {
    const sendBtn = page.locator('aside button', { hasText: 'Send' });
    await expect(sendBtn).toBeVisible();
  });

  test('can type into the chat input', async ({ page }) => {
    const textarea = page.locator('aside textarea');
    await textarea.fill('Hello, Isla!');
    await expect(textarea).toHaveValue('Hello, Isla!');
  });

  test('chat panel has Chat and Info tabs when agent has tabs config', async ({ page }) => {
    // isla has tabs in mock config, so tab buttons should be present
    const aside = page.locator('aside');
    const chatTab = aside.getByRole('button', { name: 'Chat' });
    const infoTab = aside.getByRole('button', { name: 'Info' });
    await expect(chatTab).toBeVisible();
    await expect(infoTab).toBeVisible();
  });
});

test.describe('Dashboard - Voice Toggle', () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });
    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });
    await expect(page.locator('aside')).toBeVisible({ timeout: 3000 });
  });

  test('voice toggle button is present', async ({ page }) => {
    const voiceBtn = page.locator('aside button', { hasText: 'Voice' });
    await expect(voiceBtn).toBeVisible();
  });

  test('voice toggle button shows correct initial state', async ({ page }) => {
    const voiceBtn = page.locator('aside button', { hasText: 'Voice' });
    // Initially voice is off, so button text should be "Voice" (not "Voice ON")
    await expect(voiceBtn).toHaveText('Voice');
  });
});

test.describe('Dashboard - PWA Manifest', () => {
  test('manifest.webmanifest is accessible and valid', async ({ request }) => {
    // Vite-plugin-pwa generates the manifest at this path
    const response = await request.get('/manifest.webmanifest');
    expect(response.ok()).toBeTruthy();

    const manifest = await response.json();
    expect(manifest.name).toBe('OpenClaw Office');
    expect(manifest.short_name).toBe('MCC');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons).toBeDefined();
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  test('HTML page links to the manifest', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    // The PWA plugin injects a <link rel="manifest"> tag
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute('href', /manifest/);
  });
});
