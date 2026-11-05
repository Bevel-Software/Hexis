import { useCallback, useEffect, useState } from 'react';
import { fetchLoginProvidersStrict, type LoginProviders } from '../services/sso';

/**
 * How this deployment signs people in, as far as the caller knows:
 * `loading` until the first answer, `failed` when the check could not be
 * made (never guessed — see `fetchLoginProvidersStrict`), `ready` with the
 * methods. `retry` asks again.
 */
export type SignInMethodsState =
  | { status: 'loading'; retry(): void }
  | { status: 'failed'; retry(): void }
  | { status: 'ready'; methods: LoginProviders; retry(): void };

export function useSignInMethods(): SignInMethodsState {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'failed' } | { status: 'ready'; methods: LoginProviders }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((a) => a + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchLoginProvidersStrict().then(
      (methods) => {
        if (!cancelled) setState({ status: 'ready', methods });
      },
      () => {
        if (!cancelled) setState({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { ...state, retry };
}
