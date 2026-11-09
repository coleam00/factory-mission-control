import { Fragment, type ReactElement, useState } from 'react';
import { Outlet } from 'react-router';
import { ActionToastHost } from './components/ActionToast';
import { FactoryStrip, FactoryStripBody, RewindIndicator } from './components/FactoryStrip';
import { FactorySwitcher } from './components/FactorySwitcher';
import { FlowProvider } from './components/FlowToggle';
import { ManagerPanel, useManagerDock, usePhone } from './components/ManagerDock';
import { ScreenNav } from './components/ScreenNav';
import { UnknownFactory } from './components/UnknownFactory';
import { FactoryProvider, useFactory, useUrlFactory } from './live/FactoryProvider';
import { LiveProvider, useLive } from './live/LiveProvider';

const BRAND = (
  <span className="flex items-center gap-2.5 text-base font-semibold text-[color:var(--v3-fg)]">
    <span
      aria-hidden
      className="size-5 rounded-md bg-[linear-gradient(135deg,var(--v3-live),var(--v3-you)_60%,var(--v3-brand-end))]"
    />
    Mission Control
  </span>
);

const MANAGER_GLYPH = (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    className="size-4 shrink-0 opacity-85"
  >
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
  </svg>
);

/** The footer's status line; the switcher is mounted once by `ForFactory`. */
function NavFooter({
  unknownKey,
  switcher,
  onEngine,
}: {
  unknownKey: string | undefined;
  switcher: ReactElement;
  onEngine: (engine: string | null | undefined) => void;
}): ReactElement {
  return (
    <div className="mt-auto grid grid-cols-[minmax(0,1fr)] gap-1.5 px-2 pt-2.5">
      {unknownKey === undefined ? (
        <FactoryStrip onEngine={onEngine} />
      ) : (
        // Nothing is sealed for a key that is not a factory, so nothing reads as an outage, and no
        // other factory's name or count shows, whatever the address under the key.
        <section data-url-factory="unknown">
          <FactoryStripBody factory={unknownKey} rows={undefined} state="loading" unknown />
        </section>
      )}
      {switcher}
    </div>
  );
}

function SideNav({
  unknownKey,
  switcher,
  onEngine,
  managerOpen,
  onManager,
}: {
  unknownKey: string | undefined;
  switcher: ReactElement;
  onEngine: (engine: string | null | undefined) => void;
  managerOpen: boolean;
  onManager: () => void;
}): ReactElement {
  return (
    <nav
      aria-label="Places"
      className="flex w-[var(--v3-nav-width)] shrink-0 flex-col gap-0.5 border-r border-[color:var(--v3-line)] bg-[var(--v3-bg)] px-2.5 pt-4 pb-3"
    >
      <div className="px-2 pb-4">{BRAND}</div>
      <ScreenNav layout="side" />
      <hr className="mx-1 my-2.5 border-0 border-t border-[color:var(--v3-line)]" />
      <button
        type="button"
        aria-pressed={managerOpen}
        onClick={onManager}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--v3-radius-control)] px-2.5 py-[7px] text-left text-[14.5px] text-[color:var(--v3-fg-2)] hover:bg-[var(--v3-raised)] hover:text-[color:var(--v3-fg)]"
      >
        {MANAGER_GLYPH}
        Manager
        <span className="ml-auto font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]">
          ⌘J
        </span>
      </button>
      <NavFooter unknownKey={unknownKey} switcher={switcher} onEngine={onEngine} />
    </nav>
  );
}

/** The phone's two bars: the brand with the running count on top, the five tabs at the bottom. */
function PhoneTop({
  unknownKey,
  onEngine,
}: {
  unknownKey: string | undefined;
  onEngine: (engine: string | null | undefined) => void;
}): ReactElement {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-[color:var(--v3-line)] bg-[var(--v3-bg)] px-4 py-3">
      {BRAND}
      <div className="ml-auto">
        {unknownKey === undefined ? (
          <FactoryStrip onEngine={onEngine} />
        ) : (
          <FactoryStripBody factory={unknownKey} rows={undefined} state="loading" unknown />
        )}
      </div>
    </header>
  );
}

export function PhoneTabs({
  manager,
  onManager,
}: {
  manager: boolean;
  onManager: (open: boolean) => void;
}): ReactElement {
  return (
    <nav
      aria-label="Places"
      className="sticky bottom-0 grid grid-cols-5 border-t border-[color:var(--v3-line)] bg-[var(--v3-bg)] pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom,0px))]"
    >
      <ScreenNav layout="tabs" onNavigate={() => onManager(false)} quiet={manager} />
      <button
        type="button"
        aria-pressed={manager}
        onClick={() => onManager(true)}
        className={`grid cursor-pointer justify-items-center gap-[3px] text-[11px] ${
          manager ? 'text-[color:var(--v3-fg)]' : 'text-[color:var(--v3-fg-3)]'
        }`}
      >
        {MANAGER_GLYPH}
        Manager
      </button>
    </nav>
  );
}

/**
 * Keyed by the current factory, so a switch remounts the strip and the screen: no panel keeps
 * the previous factory's rows, and no screen keeps its selection.
 */
export function ForFactory(): ReactElement {
  const factory = useFactory() ?? '';
  const inUrl = useUrlFactory();
  const live = useLive();
  const dock = useManagerDock();
  const phone = usePhone();
  const [phoneManager, setPhoneManager] = useState(false);
  const [engine, setEngine] = useState<string | null | undefined>();
  const unknownKey = inUrl.key !== undefined && inUrl.view === 'unknown' ? inUrl.key : undefined;
  const page =
    unknownKey === undefined ? (
      <Fragment key={factory}>
        <Outlet />
      </Fragment>
    ) : (
      <UnknownFactory
        factory={unknownKey}
        fallback={live.status === 'ready' ? live.factories[0] : undefined}
      />
    );
  // One switcher at every width, outside the strip's panel, so a factory switch does not re-seal it.
  const switcher = <FactorySwitcher engine={engine} />;
  const content = (
    <div className="min-w-0 flex-1 overflow-auto">
      <RewindIndicator
        rewind={unknownKey === undefined && live.status === 'ready' ? live.rewind : null}
      />
      {page}
    </div>
  );
  if (phone) {
    return (
      <div className="flex min-h-screen flex-col bg-[var(--v3-bg)]">
        <PhoneTop unknownKey={unknownKey} onEngine={setEngine} />
        {phoneManager ? <ManagerPanel phone onClose={() => setPhoneManager(false)} /> : content}
        {/* Mounted but hidden: the design draws no switcher on phone, yet it is the one publisher of the factory list. */}
        <div hidden>{switcher}</div>
        <PhoneTabs manager={phoneManager} onManager={setPhoneManager} />
      </div>
    );
  }
  return (
    <div className="flex h-screen bg-[var(--v3-bg)]">
      <SideNav
        unknownKey={unknownKey}
        switcher={switcher}
        onEngine={setEngine}
        managerOpen={dock.open}
        onManager={dock.toggle}
      />
      {content}
      {dock.open ? <ManagerPanel onClose={dock.toggle} /> : null}
    </div>
  );
}

/** Every route renders in the shell: the left nav, the page, and the docked Manager. */
export function Shell(): ReactElement {
  return (
    <LiveProvider>
      <FactoryProvider>
        <FlowProvider>
          <ForFactory />
          <ActionToastHost />
        </FlowProvider>
      </FactoryProvider>
    </LiveProvider>
  );
}
