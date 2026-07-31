import { createContext, useContext } from 'react';

export type AutoUpdateStatus = 'idle' | 'updating' | 'failed';

export interface AutoUpdateState {
  status: AutoUpdateStatus;
  branch: string | null;
  reason: string | null;
}

export const IDLE_AUTO_UPDATE: AutoUpdateState = {
  status: 'idle',
  branch: null,
  reason: null,
};

export const AutoUpdateContext = createContext<AutoUpdateState>(IDLE_AUTO_UPDATE);

export function useAutoUpdate(): AutoUpdateState {
  return useContext(AutoUpdateContext);
}
