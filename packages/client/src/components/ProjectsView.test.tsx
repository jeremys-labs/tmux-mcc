// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ProjectsView } from './ProjectsView';
import type { Project } from '../stores/projectStore';

const mockProjectStore = vi.fn();
const mockNavigate = vi.fn();
const mockUIStore = vi.fn();

vi.mock('../stores/projectStore', () => ({
  useProjectStore: (selector: (state: any) => any) => mockProjectStore(selector),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../stores/uiStore', () => ({
  useUIStore: (selector: (state: any) => any) => mockUIStore(selector),
}));

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Test Project',
  status: 'active',
  owner: 'marcus',
  ownerName: 'Marcus',
  emoji: '🔧',
  summary: 'A dev project',
  lastUpdated: new Date().toISOString(),
  ...overrides,
});

const SAMPLE_PROJECTS: Project[] = [
  makeProject({ id: 'p1', name: 'MCC Harness', status: 'active', ownerName: 'Marcus', summary: 'The tmux harness', emoji: '🔧' }),
  makeProject({ id: 'p2', name: 'My Health Copilot', status: 'active', ownerName: 'Marcus', summary: 'Flutter health app', emoji: '❤️' }),
  makeProject({ id: 'p3', name: 'FrontDesk', status: 'ready', ownerName: 'Zara', summary: 'Real estate SaaS', emoji: '🏠' }),
];

function mountLoaded(projects: Project[]) {
  mockProjectStore.mockImplementation((selector: (state: any) => any) =>
    selector({ projects, loading: false, error: null, fetchProjects: vi.fn() })
  );
  mockUIStore.mockImplementation((selector: (state: any) => any) =>
    selector({ clearView: vi.fn() })
  );
  render(<ProjectsView />);
}

describe('ProjectsView', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the filter input', () => {
    mountLoaded(SAMPLE_PROJECTS);
    expect(screen.getByPlaceholderText(/search projects/i)).toBeTruthy();
  });

  it('filters projects by name', () => {
    mountLoaded(SAMPLE_PROJECTS);

    fireEvent.change(screen.getByPlaceholderText(/search projects/i), {
      target: { value: 'Health' },
    });

    expect(screen.getByText(/My Health Copilot/i)).toBeTruthy();
    expect(screen.queryByText(/MCC Harness/i)).toBeNull();
    expect(screen.queryByText(/FrontDesk/i)).toBeNull();
  });

  it('filters projects by owner name', () => {
    mountLoaded(SAMPLE_PROJECTS);

    fireEvent.change(screen.getByPlaceholderText(/search projects/i), {
      target: { value: 'Zara' },
    });

    expect(screen.getByText(/FrontDesk/i)).toBeTruthy();
    expect(screen.queryByText(/MCC Harness/i)).toBeNull();
  });

  it('filters projects by summary text', () => {
    mountLoaded(SAMPLE_PROJECTS);

    fireEvent.change(screen.getByPlaceholderText(/search projects/i), {
      target: { value: 'Flutter' },
    });

    expect(screen.getByText(/My Health Copilot/i)).toBeTruthy();
    expect(screen.queryByText(/MCC Harness/i)).toBeNull();
  });

  it('does not show a clear button when the filter is empty', () => {
    mountLoaded(SAMPLE_PROJECTS);
    expect(screen.queryByRole('button', { name: /clear search/i })).toBeNull();
  });

  it('shows a clear button when filter has text and clicking it resets the filter', () => {
    mountLoaded(SAMPLE_PROJECTS);

    const input = screen.getByPlaceholderText(/search projects/i);
    fireEvent.change(input, { target: { value: 'Health' } });

    const clearBtn = screen.getByRole('button', { name: /clear search/i });
    expect(clearBtn).toBeTruthy();

    fireEvent.click(clearBtn);
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/MCC Harness/i)).toBeTruthy();
  });

  it('clears the filter when Escape is pressed', () => {
    mountLoaded(SAMPLE_PROJECTS);

    const input = screen.getByPlaceholderText(/search projects/i);
    fireEvent.change(input, { target: { value: 'Health' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/MCC Harness/i)).toBeTruthy();
  });

  it('shows a no-match message when the filter matches nothing', () => {
    mountLoaded(SAMPLE_PROJECTS);

    fireEvent.change(screen.getByPlaceholderText(/search projects/i), {
      target: { value: 'zzznomatch' },
    });

    expect(screen.getByText(/no projects match/i)).toBeTruthy();
    expect(screen.queryByText(/MCC Harness/i)).toBeNull();
  });

  it('shows an inline clear-search link in the no-match state that resets the filter', () => {
    mountLoaded(SAMPLE_PROJECTS);

    const input = screen.getByPlaceholderText(/search projects/i);
    fireEvent.change(input, { target: { value: 'zzznomatch' } });

    const clearLink = screen.getByText(/clear the search/i);
    fireEvent.click(clearLink);

    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/MCC Harness/i)).toBeTruthy();
  });

  it('shows "X of Y projects" count when filter is active with results', () => {
    mountLoaded(SAMPLE_PROJECTS);

    fireEvent.change(screen.getByPlaceholderText(/search projects/i), {
      target: { value: 'Marcus' },
    });

    expect(screen.getByText(/2 of 3/i)).toBeTruthy();
  });
});
