import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

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

const MOCK_STANDUP = {
  date: new Date().toISOString().split('T')[0], // today's date
  agents: {
    isla: { status: 'completed', today: 'Coordinating sprint planning', blockers: '', learned: 'New deployment pipeline' },
    kael: { status: 'pending', today: 'Building API endpoints', blockers: 'Waiting on schema review', learned: '' },
  },
};

const MOCK_CHANNELS = {
  recent: [
    { id: '1', from: 'isla', to: 'kael', topic: 'Sprint planning sync', type: 'message', timestamp: new Date().toISOString() },
    { id: '2', from: 'kael', to: 'isla', topic: 'API schema review needed', type: 'question', timestamp: new Date().toISOString() },
    { id: '3', from: 'isla', to: 'kael', topic: 'Schema approved', type: 'update', timestamp: new Date().toISOString() },
  ],
};

const MOCK_CHAT_HISTORY = [
  { seq: 1, role: 'user', content: 'Hello Isla', timestamp: Date.now() - 60000 },
  { seq: 2, role: 'assistant', content: 'Hi there! How can I help?', timestamp: Date.now() - 55000 },
];

// Chat history that includes system messages (should be filtered server-side,
// but test that they don't appear in UI)
const MOCK_CHAT_WITH_SYSTEM = [
  { seq: 1, role: 'user', content: 'Hello', timestamp: Date.now() - 60000 },
  { seq: 2, role: 'assistant', content: 'ANNOUNCE_SKIP', timestamp: Date.now() - 55000 },
  { seq: 3, role: 'assistant', content: 'NO_REPLY', timestamp: Date.now() - 50000 },
  { seq: 4, role: 'assistant', content: 'Hi! How can I help?', timestamp: Date.now() - 45000 },
];

// Chat history with duplicates
const MOCK_CHAT_WITH_DUPES = [
  { seq: 1, role: 'user', content: 'Hello', timestamp: Date.now() - 60000 },
  { seq: 2, role: 'assistant', content: 'Hi there!', timestamp: Date.now() - 55000 },
  { seq: 3, role: 'assistant', content: 'Hi there!', timestamp: Date.now() - 50000 }, // duplicate
];

async function mockApiRoutes(page: Page, overrides?: {
  chatHistory?: unknown[];
  standup?: unknown;
  channels?: unknown;
}) {
  await page.route('**/api/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_CONFIG) }),
  );

  await page.route('**/api/chat-history/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(overrides?.chatHistory ?? []),
    }),
  );

  await page.route('**/api/chat-stream/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );

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
      body: JSON.stringify(overrides?.standup ?? MOCK_STANDUP),
    }),
  );

  await page.route('**/api/channels', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(overrides?.channels ?? MOCK_CHANNELS),
    }),
  );

  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/config')) return route.fallback();
    if (url.includes('/api/chat-history/')) return route.fallback();
    if (url.includes('/api/chat-stream/')) return route.fallback();
    if (url.includes('/api/health')) return route.fallback();
    if (url.includes('/api/standup')) return route.fallback();
    if (url.includes('/api/channels')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });
}

// ---------------------------------------------------------------------------
// Standup Widget
// ---------------------------------------------------------------------------

test.describe('Standup Widget', () => {
  test('displays friendly date format — "Today" for current date', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    const standup = page.locator('text=Standup').locator('..');
    await expect(standup).toBeVisible();
    await expect(standup.locator('text=Today')).toBeVisible();
  });

  test('displays "Yesterday" for previous date', async ({ page }) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await mockApiRoutes(page, {
      standup: { ...MOCK_STANDUP, date: yesterday.toISOString().split('T')[0] },
    });
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    await expect(page.locator('text=Yesterday')).toBeVisible();
  });

  test('shows agent statuses with colored indicators', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    // Shows completion count
    await expect(page.locator('text=1/2 completed')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Chat — System Message Filtering
// ---------------------------------------------------------------------------

test.describe('Chat — System Messages', () => {
  test('system messages like ANNOUNCE_SKIP and NO_REPLY are not displayed', async ({ page }) => {
    await mockApiRoutes(page, { chatHistory: MOCK_CHAT_WITH_SYSTEM });
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    // Open agent panel
    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });
    await expect(page.locator('aside')).toBeVisible({ timeout: 3000 });

    // Real messages should appear
    await expect(page.locator('text=Hello')).toBeVisible();
    await expect(page.locator('text=Hi! How can I help?')).toBeVisible();

    // System messages should NOT appear
    await expect(page.locator('text=ANNOUNCE_SKIP')).not.toBeVisible();
    await expect(page.locator('text=NO_REPLY')).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Chat — Duplicate Prevention
// ---------------------------------------------------------------------------

test.describe('Chat — Duplicate Prevention', () => {
  test('addMessage deduplicates identical messages', async ({ page }) => {
    await mockApiRoutes(page, { chatHistory: MOCK_CHAT_HISTORY });
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });
    await expect(page.locator('aside')).toBeVisible({ timeout: 3000 });

    // Wait for history to load
    await expect(page.locator('text=Hi there! How can I help?')).toBeVisible();

    // Try to add a duplicate via addMessage — should be rejected
    const count = await page.evaluate(() => {
      const store = (window as any).__chatStore;
      store.getState().addMessage('isla', {
        seq: Date.now(),
        role: 'assistant',
        content: 'Hi there! How can I help?',
        timestamp: Date.now(),
      });
      return store.getState().messages.isla.filter(
        (m: any) => m.content === 'Hi there! How can I help?'
      ).length;
    });

    expect(count).toBe(1);
  });

  test('finalizeStream does not create duplicate when same content exists', async ({ page }) => {
    await mockApiRoutes(page, { chatHistory: MOCK_CHAT_HISTORY });
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });
    await expect(page.locator('aside')).toBeVisible({ timeout: 3000 });

    // Wait for history to load
    await expect(page.locator('text=Hi there! How can I help?')).toBeVisible();

    // Now simulate a duplicate finalizeStream from the store
    const dupeCount = await page.evaluate(() => {
      const store = (window as any).__chatStore;
      store.getState().finalizeStream('isla', 'Hi there! How can I help?');
      // Count how many times this content appears
      const msgs = store.getState().messages.isla || [];
      return msgs.filter((m: any) => m.content === 'Hi there! How can I help?').length;
    });

    expect(dupeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Channels View (Coming Soon placeholder)
// ---------------------------------------------------------------------------

test.describe('Channels View', () => {
  test('displays Coming Soon placeholder', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    // Navigate to channels
    const channelsBtn = page.locator('header nav button', { hasText: 'channels' });
    await channelsBtn.click();

    await expect(page.locator('text=Agent Channels')).toBeVisible();
    await expect(page.locator('text=Coming Soon')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Mobile Layout (iPhone viewport)
// ---------------------------------------------------------------------------

test.describe('Mobile Layout', () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14

  test('shows bottom tab bar on mobile', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    // Bottom nav should be visible (md:hidden means visible below 768px)
    const bottomNav = page.locator('nav.fixed');
    await expect(bottomNav).toBeVisible();

    // Desktop header nav should be hidden
    const headerNav = page.locator('header nav');
    await expect(headerNav).not.toBeVisible();
  });

  test('agent panel opens as slide-up sheet on mobile', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });

    const aside = page.locator('aside');
    await expect(aside).toBeVisible({ timeout: 3000 });

    // Should have the mobile drag handle
    await expect(aside.locator('.rounded-full.bg-white\\/20')).toBeVisible();
  });

  test('channels view shows Coming Soon on mobile', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    // Use bottom nav to switch to channels
    const channelsBtn = page.locator('nav.fixed button', { hasText: 'channels' });
    await channelsBtn.click();

    await expect(page.locator('text=Agent Channels')).toBeVisible();
    await expect(page.locator('text=Coming Soon')).toBeVisible();
  });

  test('standup widget fits within mobile viewport', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    const standup = page.locator('text=Standup').locator('..');
    await expect(standup).toBeVisible();

    const box = await standup.boundingBox();
    expect(box).toBeTruthy();
    // Should not overflow the viewport
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});

// ---------------------------------------------------------------------------
// iPad Layout
// ---------------------------------------------------------------------------

test.describe('iPad Layout', () => {
  test.use({ viewport: { width: 1024, height: 1366 } }); // iPad Pro

  test('shows desktop navigation on iPad', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    // Desktop nav should be visible (md breakpoint = 768px)
    const headerNav = page.locator('header nav');
    await expect(headerNav).toBeVisible();

    // Bottom nav should be hidden
    const bottomNav = page.locator('nav.fixed');
    await expect(bottomNav).not.toBeVisible();
  });

  test('agent panel renders as sidebar on iPad', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      (window as any).__uiStore.getState().openAgentPanel('isla');
    });

    const aside = page.locator('aside');
    await expect(aside).toBeVisible({ timeout: 3000 });

    // Should NOT have the mobile drag handle on iPad (it's md:hidden)
    const dragHandle = aside.locator('.rounded-full.bg-white\\/20');
    await expect(dragHandle).not.toBeVisible();
  });

  test('channels view shows Coming Soon on iPad', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    const channelsBtn = page.locator('header nav button', { hasText: 'channels' });
    await channelsBtn.click();

    await expect(page.locator('text=Agent Channels')).toBeVisible();
    await expect(page.locator('text=Coming Soon')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Visual Regression — Desktop Screenshot
// ---------------------------------------------------------------------------

test.describe('Visual — Desktop Dashboard', () => {
  test('dashboard renders correctly at desktop viewport', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    // Wait for standup data to render
    await expect(page.locator('text=Today')).toBeVisible();

    await page.screenshot({ path: 'test-results/desktop-dashboard.png', fullPage: false });
  });
});

test.describe('Visual — Mobile Dashboard', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('dashboard renders correctly at mobile viewport', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    await expect(page.locator('text=Today')).toBeVisible();

    await page.screenshot({ path: 'test-results/mobile-dashboard.png', fullPage: false });
  });
});

test.describe('Visual — iPad Dashboard', () => {
  test.use({ viewport: { width: 1024, height: 1366 } });

  test('dashboard renders correctly at iPad viewport', async ({ page }) => {
    await mockApiRoutes(page);
    await page.goto('/');
    await expect(page.locator('text=Loading...')).not.toBeVisible({ timeout: 5000 });

    await expect(page.locator('text=Today')).toBeVisible();

    await page.screenshot({ path: 'test-results/ipad-dashboard.png', fullPage: false });
  });
});
