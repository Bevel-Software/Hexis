import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ConfirmProvider, useConfirm, type ConfirmAnswer } from '..';

/**
 * The app's own confirmation. It resolves only on the person's answer —
 * Confirm, Cancel, Escape, the scrim or the X — never on anything the browser
 * decides, and it asks one question at a time.
 */

const wrapper = ({ children }: { children: ReactNode }) => <ConfirmProvider>{children}</ConfirmProvider>;

afterEach(() => vi.restoreAllMocks());

function ask(request: Parameters<ReturnType<typeof useConfirm>>[0] = { title: 'Delete', message: 'Delete it?' }) {
  const { result } = renderHook(() => useConfirm(), { wrapper });
  let answer!: Promise<ConfirmAnswer>;
  act(() => {
    answer = result.current(request);
  });
  return { answer, confirm: result.current };
}

describe('ConfirmProvider', () => {
  it('confirms only on the confirm button', async () => {
    const { answer } = ask({ title: 'Delete', message: 'Delete it?', confirmLabel: 'Delete', destructive: true });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete it?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await expect(answer).resolves.toEqual({ confirmed: true, dontAskAgain: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['the X', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    [
      'the scrim',
      () => {
        const scrim = screen.getByRole('dialog').parentElement!;
        fireEvent.mouseDown(scrim);
        fireEvent.click(scrim);
      },
    ],
  ])('counts %s as Cancel', async (_name, dismiss) => {
    const { answer } = ask();
    await screen.findByRole('dialog');
    dismiss();
    await expect(answer).resolves.toEqual({ confirmed: false, dontAskAgain: false });
  });

  it('offers "Don\'t ask again" only when asked to, and reports the tick on confirm', async () => {
    const plain = ask();
    expect(within(await screen.findByRole('dialog')).queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await plain.answer;

    const { answer } = ask({ title: 'Delete', message: 'Delete it?', offerDontAskAgain: true });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: "Don't ask again" }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await expect(answer).resolves.toEqual({ confirmed: true, dontAskAgain: true });
  });

  it('is not answered by the browser: a suppressed window.confirm is never consulted', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { answer } = ask();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'OK' }));
    await expect(answer).resolves.toMatchObject({ confirmed: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks one question at a time, in order', async () => {
    const { result } = renderHook(() => useConfirm(), { wrapper });
    let first!: Promise<ConfirmAnswer>;
    let second!: Promise<ConfirmAnswer>;
    act(() => {
      first = result.current({ title: 'One', message: 'First?' });
      second = result.current({ title: 'Two', message: 'Second?' });
    });
    await screen.findByRole('dialog');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('First?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(first).resolves.toMatchObject({ confirmed: false });
    expect(await screen.findByText('Second?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await expect(second).resolves.toMatchObject({ confirmed: true });
  });

  it('answers a queued question on the first click once it comes up', async () => {
    const { result } = renderHook(() => useConfirm(), { wrapper });
    let first!: Promise<ConfirmAnswer>;
    let second!: Promise<ConfirmAnswer>;
    act(() => {
      first = result.current({ title: 'One', message: 'First?' });
      second = result.current({ title: 'Two', message: 'Second?' });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await expect(first).resolves.toMatchObject({ confirmed: true });
    // Clicked in the same tick the second dialog commits: no second click
    // needed, nothing dropped.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await expect(second).resolves.toMatchObject({ confirmed: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('gives the dialog its question as the accessible description', async () => {
    ask({ title: 'Delete branch', message: 'Delete "alice/draft"?' });
    const dialog = await screen.findByRole('dialog', { name: 'Delete branch' });
    expect(dialog).toHaveAccessibleDescription('Delete "alice/draft"?');
  });

  it('keeps line breaks in a string question', async () => {
    ask({ title: 'Unsaved', message: 'You have unsaved changes in:\n  - a.md\nClose anyway?' });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('You have unsaved changes in:\n  - a.md\nClose anyway?');
  });

  it('answers open questions Cancel when it goes away', async () => {
    const { result, unmount } = renderHook(() => useConfirm(), { wrapper });
    let answer!: Promise<ConfirmAnswer>;
    act(() => {
      answer = result.current({ title: 'Delete', message: 'Delete it?' });
    });
    await screen.findByRole('dialog');
    unmount();
    await expect(answer).resolves.toEqual({ confirmed: false, dontAskAgain: false });
  });

  it('refuses loudly without a provider rather than inventing an answer', async () => {
    const { result } = renderHook(() => useConfirm());
    await expect(result.current({ title: 'x', message: 'y' })).rejects.toThrow(/ConfirmProvider/);
  });

  it('renders inside the page normally', () => {
    render(<ConfirmProvider><p>page</p></ConfirmProvider>);
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
