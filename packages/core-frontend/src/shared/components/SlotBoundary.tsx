import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Banner } from './Banner';

interface SlotBoundaryProps {
  children: ReactNode;
  /**
   * What the slot holds, as the page would name it to the person reading:
   * "workspace panel". It completes the sentence shown in its place.
   */
  label: string;
}

interface SlotBoundaryState {
  failed: boolean;
}

/**
 * A fence around a component core did not write.
 *
 * A registry slot hands part of a core page to the distribution that runs
 * it. Without a boundary, a throw while that component renders unmounts the
 * whole page around it, because React takes down the nearest tree that has
 * one — so a fault in the part core knows nothing about would cost the
 * person the part core does own. The slot's failure stays the slot's: its
 * place says it could not be shown, and everything else on the page stands.
 *
 * It does not retry. What failed is the distribution's code on this render;
 * rendering it again gets the same throw, and the page has a reload for the
 * day the cause was something that passes.
 */
export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  state: SlotBoundaryState = { failed: false };

  static getDerivedStateFromError(): SlotBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[slot] the ${this.props.label} failed to render`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Banner tone="danger" role="alert">
        The {this.props.label} couldn&rsquo;t be shown. The rest of this page is unaffected; reload to try
        again.
      </Banner>
    );
  }
}
