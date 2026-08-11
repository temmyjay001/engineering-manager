import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewItemDialog } from './board';

const createTicket = vi.fn();
const createEpic = vi.fn();
const createDraftTicket = vi.fn();

vi.mock('@/lib/api', () => ({
  createTicket: (...args: unknown[]) => createTicket(...args),
  createEpic: (...args: unknown[]) => createEpic(...args),
  createDraftTicket: (...args: unknown[]) => createDraftTicket(...args),
}));

const navigate = vi.fn();

vi.mock('@/lib/router', () => ({
  navigate: (...args: unknown[]) => navigate(...args),
  projectPath: (projectId: string, sub = '') => `/p/${projectId}${sub}`,
  projectHref: (projectId: string, sub = '') => `#/p/${projectId}${sub}`,
}));

function openDialog() {
  render(<NewItemDialog projectId="proj" onCreated={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /new/i }));
}

beforeEach(() => {
  createTicket.mockReset();
  createEpic.mockReset();
  createDraftTicket.mockReset();
  navigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('NewItemDialog mode switching', () => {
  it('defaults to the Quick create tab', () => {
    openDialog();
    expect(screen.getByPlaceholderText(/dark mode toggle/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/export their data as csv/i)).toBeNull();
  });

  it('switches to Draft with PM without losing Quick create text, and back without losing draft text', () => {
    openDialog();
    fireEvent.change(screen.getByPlaceholderText(/dark mode toggle/i), { target: { value: 'quick idea' } });

    fireEvent.click(screen.getByRole('button', { name: 'Draft with PM' }));
    expect(screen.queryByPlaceholderText(/dark mode toggle/i)).toBeNull();
    const ideaField = screen.getByPlaceholderText(/export their data as csv/i) as HTMLTextAreaElement;
    fireEvent.change(ideaField, { target: { value: 'draft idea' } });

    fireEvent.click(screen.getByRole('button', { name: 'Quick create' }));
    expect((screen.getByPlaceholderText(/dark mode toggle/i) as HTMLTextAreaElement).value).toBe('quick idea');

    fireEvent.click(screen.getByRole('button', { name: 'Draft with PM' }));
    expect((screen.getByPlaceholderText(/export their data as csv/i) as HTMLTextAreaElement).value).toBe('draft idea');
  });

  it('supports both ticket and epic sub-modes under Quick create', () => {
    openDialog();
    expect(screen.getByRole('button', { name: /create ticket/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'epic' }));
    expect(screen.getByRole('button', { name: /create epic/i })).toBeTruthy();
    expect(screen.getByPlaceholderText(/reporting module/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ticket' }));
    expect(screen.getByRole('button', { name: /create ticket/i })).toBeTruthy();
  });

  it('disables the Draft with PM submit button until the idea is non-empty', () => {
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Draft with PM' }));
    const submit = screen.getByRole('button', { name: /start draft/i });
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/export their data as csv/i), { target: { value: 'an idea' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('submits a draft-creation request and navigates to the drafting workspace on success', async () => {
    createDraftTicket.mockResolvedValue({ key: 'EM-9' });
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Draft with PM' }));
    fireEvent.change(screen.getByPlaceholderText(/export their data as csv/i), { target: { value: 'an idea' } });
    fireEvent.click(screen.getByRole('button', { name: /start draft/i }));

    await vi.waitFor(() => expect(createDraftTicket).toHaveBeenCalledWith('proj', 'an idea', []));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/p/proj/tickets/EM-9'));
    await vi.waitFor(() => expect(screen.queryByPlaceholderText(/export their data as csv/i)).toBeNull());
  });

  it('keeps the dialog open and shows an error when draft creation fails', async () => {
    createDraftTicket.mockRejectedValue(new Error('boom'));
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Draft with PM' }));
    fireEvent.change(screen.getByPlaceholderText(/export their data as csv/i), { target: { value: 'an idea' } });
    fireEvent.click(screen.getByRole('button', { name: /start draft/i }));

    await vi.waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/export their data as csv/i)).toBeTruthy();
  });
});
