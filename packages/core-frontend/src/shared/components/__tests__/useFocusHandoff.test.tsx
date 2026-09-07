import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { useFocusHandoff } from '../useFocusHandoff';

type View = 'doc' | 'log' | 'diff';

/**
 * Two views sharing one column, each with the button that swaps to the other
 * — the shape the Knowledge viewer and the skill page both have. The column
 * also carries a control that swaps the view WITHOUT naming a destination
 * for focus, standing in for a git poll or a file switch.
 */
function Column({ initial = 'doc' }: { initial?: View }) {
  const [view, setView] = useState<View>(initial);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const handoff = useFocusHandoff(view);
  return (
    <>
      <button onClick={() => setView((v) => (v === 'doc' ? 'log' : 'doc'))}>Swap unasked</button>
      {view === 'doc' ? (
        <button
          ref={openRef}
          onClick={() => {
            handoff('log', closeRef);
            setView('log');
          }}
        >
          Open the log
        </button>
      ) : view === 'log' ? (
        <button
          ref={closeRef}
          onClick={() => {
            handoff('doc', openRef);
            setView('doc');
          }}
        >
          Back to the document
        </button>
      ) : (
        <button
          onClick={() => {
            // The first named control is not part of the document view;
            // the second is.
            handoff('doc', closeRef, openRef);
            setView('doc');
          }}
        >
          Leave the comparison
        </button>
      )}
    </>
  );
}

describe('useFocusHandoff', () => {
  it('moves focus to the named control once the swap has landed, both ways', async () => {
    const user = userEvent.setup();
    render(<Column />);

    await user.click(screen.getByRole('button', { name: 'Open the log' }));
    expect(screen.getByRole('button', { name: 'Back to the document' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Back to the document' }));
    expect(screen.getByRole('button', { name: 'Open the log' })).toHaveFocus();
  });

  it('falls through to the next named control when the first is not on screen', async () => {
    const user = userEvent.setup();
    render(<Column initial="diff" />);

    await user.click(screen.getByRole('button', { name: 'Leave the comparison' }));
    expect(screen.getByRole('button', { name: 'Open the log' })).toHaveFocus();
  });

  it('moves nothing for a swap the user did not make', async () => {
    const user = userEvent.setup();
    render(<Column />);

    const unasked = screen.getByRole('button', { name: 'Swap unasked' });
    await user.click(unasked);
    expect(screen.getByRole('button', { name: 'Back to the document' })).toBeInTheDocument();
    // The control that swapped the view is still on screen and keeps focus;
    // nothing was named, so nothing moved.
    expect(unasked).toHaveFocus();
  });

  /**
   * The request names the state it is for. A commit that lands somewhere
   * else — the stale passive effects React flushes ahead of a click's render
   * are the case that bit — leaves it waiting for the commit that gets there.
   */
  it('waits for the named state rather than the next commit', async () => {
    function Probe() {
      const [view, setView] = useState<View>('doc');
      const target = useRef<HTMLButtonElement>(null);
      const handoff = useFocusHandoff(view);
      return (
        <>
          <button
            onClick={() => {
              handoff('log', target);
              setView('diff');
            }}
          >
            Ask for the log, land elsewhere
          </button>
          <button onClick={() => setView('log')}>Now the log</button>
          {view === 'log' && <button ref={target}>Landed</button>}
          <output>{view}</output>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Probe />);

    const ask = screen.getByRole('button', { name: 'Ask for the log, land elsewhere' });
    await user.click(ask);
    expect(screen.getByRole('status')).toHaveTextContent('diff');
    expect(ask).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Now the log' }));
    expect(screen.getByRole('button', { name: 'Landed' })).toHaveFocus();
  });
});
