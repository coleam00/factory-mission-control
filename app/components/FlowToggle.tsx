import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';
import { useReducedMotion } from './FactoryMap';

interface Flow {
  flow: boolean;
  setFlow: (flow: boolean) => void;
  /** Whether the map the toggle moves is on the page. */
  drawn: boolean;
  setDrawn: (drawn: boolean) => void;
}

const FlowContext = createContext<Flow>({
  flow: true,
  setFlow: () => {},
  drawn: false,
  setDrawn: () => {},
});

/** Holds the map's flow choice for the header bar's toggle and the home map it moves. */
export function FlowProvider({ children }: { children: ReactNode }): ReactElement {
  const [flow, setFlow] = useState(true);
  const [drawn, setDrawn] = useState(false);
  const value = useMemo(() => ({ flow, setFlow, drawn, setDrawn }), [flow, drawn]);
  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export const useFlow = (): Flow => useContext(FlowContext);

/** The flow toggle: shown with the map it moves, and off while the system asks for no motion. */
export function FlowToggle(): ReactElement | null {
  const { flow, setFlow, drawn } = useFlow();
  const reduced = useReducedMotion();
  if (!drawn) return null;
  return (
    <button
      type="button"
      aria-pressed={flow && !reduced}
      aria-label="Flow animation"
      title={
        reduced
          ? 'Flow animation is off: your system asks for reduced motion'
          : 'Toggle flow animation'
      }
      disabled={reduced}
      onClick={() => setFlow(!flow)}
      className={`cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] hover:border-border-bright hover:text-text-primary disabled:cursor-default ${
        flow && !reduced ? 'text-text-primary' : 'text-text-secondary'
      }`}
    >
      ≋ flow
    </button>
  );
}
