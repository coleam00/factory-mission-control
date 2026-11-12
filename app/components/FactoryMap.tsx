import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  allCards,
  type Card,
  CHIPS,
  type Chip,
  cardWidth,
  FIT_FOOT,
  fitCamera,
  heroFrameHeight,
  levelOf,
  MAP_TYPE,
  MIN_FRAME,
  type FactoryMap as FactoryMapData,
  type Line,
  type LineStyle,
  linePoints,
  type MapView,
  midpoint,
  neighbours,
  openCamera,
  openerOf,
  type Point,
  PHONE,
  pathOf,
  type Role,
  tourPoints,
  worldSize,
} from '../map/factory-map';
import { MAP_CHIP_STATE, type State, stateColor, stateInk, stateWash } from '../lib/states';
import type { StepRow } from '../lib/step-detail';
import type { CardLive } from '../map/live';
import { MapDetails } from './MapDetails';

const ROLE_COLOR: Record<Role, string> = {
  source: 'var(--v3-role-source)',
  agent: 'var(--v3-role-agent)',
  test: 'var(--v3-role-test)',
  person: 'var(--v3-role-person)',
};

/** A color over transparent, so every rendered color stays a token (harness/design-probe.js). */
const over = (color: string, amount: string) =>
  `color-mix(in srgb, ${color} ${amount}, transparent)`;

const LINE_COLOR: Record<LineStyle, string> = {
  flow: 'var(--v3-fg-3)',
  loop: 'var(--v3-fg-3)',
  ask: 'var(--v3-role-person)',
};
const LINE_DASH: Record<LineStyle, string | undefined> = {
  flow: undefined,
  loop: '6 5',
  ask: '3 4',
};

/** A wire label's Geist Mono advance per character, 0.6em, rounded up. */
const LABEL_CHAR_W = Math.ceil(MAP_TYPE.label * 0.6);
/** How far a press must move before it is a drag, not a click, in pixels. */
const DRAG_SLOP = 3;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.4;
/**
 * Below `PHONE` the map opens as refs/40-home-phone.png draws it: the line at a readable scale,
 * centred between Review and App check, the rest a pan away. Fit still fits the whole map.
 */
const PHONE_SCALE = 0.42;
const PHONE_FRAME = 460;

interface Camera {
  x: number;
  y: number;
  k: number;
}

/** Where the details panel docks in the frame: on the half away from the press that selected a card. */
type Side = 'left' | 'right' | 'top' | 'bottom';

/** The side of the frame, from its width up, away from a point in it. */
function sideAway(point: Point, frame: { width: number; height: number }): Side {
  if (frame.width >= PHONE) return point[0] < frame.width / 2 ? 'right' : 'left';
  return point[1] < frame.height / 2 ? 'bottom' : 'top';
}

/** Where a card's centre is in the frame under `cam`. */
const cardCentre = (level: MapView, card: Card, cam: Camera): Point => [
  cam.x + (card.x + cardWidth(level, card) / 2) * cam.k,
  cam.y + (card.y + level.cardSize.height / 2) * cam.k,
];

/** The details panel's box in the frame; its top and bottom clear the hint and the controls. */
function detailsStyle(side: Side): CSSProperties {
  if (side === 'left' || side === 'right') {
    return { top: 12, bottom: 56, width: 'min(400px, calc(50% - 18px))', [side]: 12 };
  }
  return { left: 12, right: 12, height: 'calc(50% - 62px)', [side]: side === 'top' ? 12 : 56 };
}

const reducedQuery = '(prefers-reduced-motion: reduce)';
const reducedMotion = () => window.matchMedia(reducedQuery).matches;
const subscribeMotion = (onChange: () => void) => {
  const query = window.matchMedia(reducedQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** Whether the system asks for reduced motion, which stops the map's motion whatever the toggle says. */
export const useReducedMotion = () =>
  useSyncExternalStore(subscribeMotion, reducedMotion, () => false);

/** The point `fraction` of the way along a polyline, and how far along each vertex lies. */
function along(points: readonly Point[]): {
  at: (fraction: number) => Point;
  vertices: number[];
} {
  const vertices = [0];
  for (const [i, [x, y]] of points.slice(1).entries()) {
    const [px, py] = points[i] as Point;
    vertices.push((vertices[i] as number) + Math.hypot(x - px, y - py));
  }
  const total = vertices[vertices.length - 1] as number;
  return {
    vertices: vertices.map((v) => v / total),
    at: (fraction) => {
      const distance = fraction * total;
      const i = Math.max(
        0,
        vertices.findIndex((v) => v >= distance),
      );
      if (i === 0) return points[0] as Point;
      const [x0, y0] = points[i - 1] as Point;
      const [x1, y1] = points[i] as Point;
      const span = (vertices[i] as number) - (vertices[i - 1] as number);
      const t = span === 0 ? 0 : (distance - (vertices[i - 1] as number)) / span;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    },
  };
}

/**
 * One dot travels the tour on a loop and each card pulses once as the dot reaches it. Drawn
 * straight to the DOM each frame, so the map does not re-render 60 times a second.
 */
function useTour(
  map: MapView,
  running: boolean,
  dot: RefObject<SVGCircleElement | null>,
  cards: RefObject<Map<string, HTMLElement>>,
): void {
  useEffect(() => {
    if (!running) return;
    const points = tourPoints(map);
    const path = along(points);
    const centres = new Set(
      map.tour.map((id) => {
        const card = map.cards.find((c) => c.id === id) as Card;
        return `${card.x + cardWidth(map, card) / 2},${card.y + map.cardSize.height / 2}`;
      }),
    );
    const stops = points
      .map((p, i) => [p, path.vertices[i] as number] as const)
      .filter(([p]) => centres.has(`${p[0]},${p[1]}`))
      .map(([, at], i) => ({ at, id: map.tour[i] as string }));
    const duration = Math.max(5000, map.tour.length * 1100);
    const started = performance.now();
    let last = -1;
    let frame = 0;
    const step = (now: number) => {
      const fraction = ((now - started) % duration) / duration;
      const [x, y] = path.at(fraction);
      dot.current?.setAttribute('cx', String(x));
      dot.current?.setAttribute('cy', String(y));
      for (const [i, stop] of stops.entries()) {
        if (i === last || Math.abs(fraction - stop.at) >= 0.012) continue;
        last = i;
        const card = cards.current.get(stop.id);
        flash(card);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [map, running, dot, cards]);
}

/**
 * Where the phone view centres (refs/40-home-phone.png): the middle of the line's box, high
 * enough that the card above the line shows too.
 */
const phoneCentre = (level: MapView, world: { width: number; height: number }): Point =>
  level.group
    ? [level.group.x + level.group.width / 2, (level.group.y + level.group.height) / 2]
    : [world.width / 2, world.height / 2];

/** Whether a key press came from somewhere the person is typing, where Backspace is theirs. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** The stacked edge behind a card that opens a deeper view, in map units. */
const STACK = '8px 8px 0 -2px var(--v3-panel), 8px 8px 0 0 var(--v3-line-2)';

/** Joins view ids into one key; ids may contain `/` (`build/deliver`), so not that. */
const PATH_SEP = '\n';

/** The camera zoom onto a card as it opens, and where it starts on the level it opens into. */
const ZOOM_IN = 2.2;
const ENTER_SCALE = 0.5;
const LEAVE_SCALE = 1.6;
/** The cross-fade: the old level is gone by SWAP_MS, the new one is fitted and settled by SETTLE_MS. */
const SWAP_MS = 240;
const FLASH_MS = 700;
const SETTLE_MS = 450;
const WORLD_MOTION = 'transform .42s cubic-bezier(.65,0,.35,1), opacity .16s';

function flash(el: HTMLElement | undefined): void {
  if (!el) return;
  el.classList.remove('animate-map-hit');
  void el.offsetWidth;
  el.classList.add('animate-map-hit');
}

/** How each chip is worded; a mapped type, so a chip in CHIPS without a word fails type-check. */
const CHIP_WORD: Record<Chip, string> = {
  queued: 'queued',
  failing: 'failing',
  waiting: 'waiting',
  merged: 'merged',
  orders: 'open',
};

const NEUTRAL_CHIP = 'bg-[var(--v3-raised)] text-[color:var(--v3-fg)]';

interface ChipLook {
  chip: string;
  text: string;
  /** The state the chip names; a chip without one is a plain count. */
  state?: State;
  className?: string;
  pulse?: boolean;
}

function chipsOf(live: CardLive | undefined): ChipLook[] {
  if (live === undefined) return [];
  const chips: ChipLook[] = [];
  const add = (chip: string, n: number | undefined, word: string, state?: State) => {
    if (n)
      chips.push({
        chip,
        text: `${n} ${word}`,
        state,
        className: state ? undefined : NEUTRAL_CHIP,
        pulse: chip === 'here',
      });
  };
  add('here', live.here.length, 'here', MAP_CHIP_STATE.here);
  for (const chip of CHIPS) {
    if (live.unavailable?.includes(chip)) {
      chips.push({
        chip,
        text: `? ${chip}`,
        className: 'bg-[var(--v3-raised)] text-[color:var(--v3-fg-2)]',
      });
    } else {
      add(
        chip,
        live[chip]?.length,
        CHIP_WORD[chip],
        chip === 'orders' ? undefined : MAP_CHIP_STATE[chip],
      );
    }
  }
  return chips;
}

function MapCard({
  map,
  card,
  live,
  state,
  onSelect,
  onOpen,
  onUp,
  register,
}: {
  map: MapView;
  card: Card;
  live: CardLive | undefined;
  state: 'selected' | 'near' | 'dim' | 'plain';
  /** `press` is where a mouse press selected it, in client pixels; absent for the keyboard. */
  onSelect: (id: string, press?: Point) => void;
  onOpen: (view: string) => void;
  /** Goes up to the card of the parent level that `card.upTo` names. */
  onUp: (target: string) => void;
  register: (id: string, el: HTMLElement | null) => void;
}): ReactElement {
  const color = ROLE_COLOR[card.role];
  const chips = chipsOf(live);
  const counts = chips.map((c) => c.text).join(', ');
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (card.upTo !== undefined) onUp(card.upTo);
    else if (event.key === 'Enter' && state === 'selected' && card.opens !== undefined) {
      onOpen(card.opens);
    } else onSelect(card.id);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holds blocks, which a <button> may not
    <div
      ref={(el) => register(card.id, el)}
      role="button"
      tabIndex={0}
      aria-pressed={state === 'selected'}
      aria-label={`${card.title}. ${card.text}${counts ? `. ${counts}` : ''}${
        card.opens === undefined ? '' : '. Opens a deeper view'
      }`}
      data-card={card.id}
      data-opens={card.opens}
      data-role={card.role}
      data-live-count={live?.here.length ?? 0}
      onClick={(event) => {
        event.stopPropagation();
        if (card.upTo !== undefined) onUp(card.upTo);
        else onSelect(card.id, event.detail > 0 ? [event.clientX, event.clientY] : undefined);
      }}
      onDoubleClick={() => card.opens !== undefined && onOpen(card.opens)}
      onKeyDown={onKey}
      data-selected={state === 'selected' || undefined}
      className={`absolute cursor-pointer select-none rounded-[16px] border-2 bg-[var(--v3-panel)] pt-3 pr-3 pb-3 pl-4 transition-[opacity,box-shadow,border-color] duration-200 ${
        state === 'selected'
          ? ''
          : 'hover:border-[color:var(--v3-fg)] hover:shadow-[0_0_0_3px_var(--v3-fg-2)]'
      } ${state === 'dim' ? 'opacity-30 focus-visible:opacity-100' : ''} ${
        state === 'selected' ? 'shadow-[0_0_0_7px_var(--v3-fg-2)]' : ''
      }`}
      style={{
        left: card.x,
        top: card.y,
        width: cardWidth(map, card),
        height: map.cardSize.height,
        borderColor: state === 'selected' ? 'var(--v3-bg)' : over(color, 'var(--card-border-tint)'),
        ...(card.opens === undefined
          ? {}
          : { boxShadow: state === 'selected' ? `0 0 0 7px var(--v3-fg-2), ${STACK}` : STACK }),
      }}
    >
      {card.opens === undefined ? null : (
        <span
          aria-hidden="true"
          className="absolute top-2.5 right-3 font-mono text-[color:var(--v3-fg-2)]"
          style={{ fontSize: MAP_TYPE.chip }}
        >
          ⤢
        </span>
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[14px]"
        style={{ background: over(color, 'var(--card-tint)') }}
      />
      <span
        aria-hidden="true"
        className="absolute top-3.5 bottom-3.5 left-0 w-[5px] rounded-r-[4px]"
        style={{ background: color }}
      />
      <span className="relative flex flex-col">
        <span
          data-card-kind
          className="font-mono uppercase leading-[1.2] tracking-[0.06em]"
          style={{ color, fontSize: MAP_TYPE.kind }}
        >
          {card.kind}
        </span>
        <span
          data-card-title
          className="mt-1 font-semibold leading-[1.15] text-[color:var(--v3-fg)]"
          style={{ fontSize: MAP_TYPE.title }}
        >
          {card.title}
        </span>
        <span
          data-card-text
          className="mt-1.5 leading-[1.3] text-[color:var(--v3-fg-2)]"
          style={{ fontSize: MAP_TYPE.text }}
        >
          {card.text}
        </span>
        {chips.length > 0 ? (
          <span className="mt-2.5 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <span
                key={c.chip}
                data-chip={c.chip}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 font-mono tabular-nums ${c.className ?? ''}`}
                style={{
                  fontSize: MAP_TYPE.chip,
                  ...(c.state ? { background: stateWash(c.state), color: stateInk(c.state) } : {}),
                }}
              >
                {c.pulse ? (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full motion-safe:animate-pulse"
                    style={{ background: stateColor('running') }}
                  />
                ) : null}
                {c.text}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function Wire({
  line,
  points,
  hot,
  dimmed,
  flow,
}: {
  line: Line;
  points: Point[];
  hot: boolean;
  dimmed: boolean;
  flow: boolean;
}): ReactElement {
  const d = pathOf(points);
  return (
    <g data-line={`${line.from}-${line.to}`} data-hot={hot || undefined}>
      <path
        d={d}
        fill="none"
        stroke={LINE_COLOR[line.style]}
        strokeWidth={2.4}
        strokeDasharray={LINE_DASH[line.style]}
        opacity={dimmed ? 0.18 : 0.75}
        markerEnd={line.arrow === false ? undefined : `url(#map-arrow-${line.style})`}
      />
      {flow && line.style === 'flow' ? (
        <path
          data-flow
          d={d}
          fill="none"
          stroke="var(--v3-fg-2)"
          strokeWidth={3}
          strokeDasharray="8 64"
          opacity={0.55}
          className="animate-map-flow motion-reduce:hidden"
        />
      ) : null}
    </g>
  );
}

function WireLabel({ text, at }: { text: string; at: Point }): ReactElement {
  const width = text.length * LABEL_CHAR_W + 12;
  const height = MAP_TYPE.label + 8;
  return (
    <g data-line-label>
      <rect
        x={at[0] - width / 2}
        y={at[1] - height - 3}
        width={width}
        height={height}
        rx={5}
        fill="var(--v3-bg)"
      />
      <text
        x={at[0]}
        y={at[1] - 3 - height / 2}
        dominantBaseline="central"
        textAnchor="middle"
        className="font-mono"
        fontSize={MAP_TYPE.label}
        fill="var(--v3-fg-2)"
      >
        {text}
      </text>
    </g>
  );
}

/** The app's column, which the caption and legend keep while the map spans the window. */
const COLUMN = 'mx-auto w-full max-w-6xl px-6';

const CONTROL =
  'cursor-pointer rounded-md px-[9px] py-1 font-mono text-[12px] text-[color:var(--v3-fg-2)] hover:bg-[var(--v3-raised)] hover:text-[color:var(--v3-fg)] disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[color:var(--v3-fg-2)]';

/**
 * The factory map (PRD 4.1): the owner's drawing with live chips on its cards, a camera that pans,
 * zooms around the cursor and fits the stage, and a details panel inside the frame, on the side
 * away from the card clicked. A drag from anywhere, a card included, pans; a press without movement
 * selects. A card with `opens` zooms into its view; `path` names the view shown (the address), and
 * the one component draws every level. `flow` off, or `prefers-reduced-motion`, stops the travelling dot and the
 * flowing dashes.
 */
export function FactoryMap({
  map,
  live,
  factory,
  at,
  flow,
  path,
  onPath,
  onDrawn,
  steps,
  stepsFailed,
  aside,
  select,
}: {
  map: FactoryMapData;
  live: ReadonlyMap<string, CardLive>;
  factory: string;
  at: string | null;
  flow: boolean;
  /** The view ids from the root down to the level to show; `[]` is the home map. */
  path: readonly string[];
  /** Asks for another level, as an address change; the map follows once `path` changes. */
  onPath: (path: readonly string[]) => void;
  /** Told true once the map is on the page and false when it leaves, for the flow toggle. */
  onDrawn?: (drawn: boolean) => void;
  /** The pinned version's steps, for Behind the scenes; undefined until they arrive. */
  steps?: readonly StepRow[];
  /** True when `step-detail` failed, so Behind the scenes says so instead of loading forever. */
  stepsFailed?: boolean;
  /** Sits beside the breadcrumb, such as the version line. */
  aside?: ReactNode;
  /** The card to have selected when the map first shows, such as the one a step screen came from. */
  select?: string;
}): ReactElement {
  const [shown, setShown] = useState(path);
  const level = levelOf(map, shown);
  const world = useMemo(() => worldSize(level), [level]);
  const rootWorld = useMemo(() => worldSize(map), [map]);
  // Read by the camera's callbacks, which must not change with the level (the frame observer
  // would refit mid-transition).
  const levelRef = useRef({ level, world });
  levelRef.current = { level, world };
  const stage = useRef<HTMLElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const cardEls = useRef(new Map<string, HTMLElement>());
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, k: 0.5 });
  // The camera as the person's input reads it: a drag, a wheel and a placement compose on this, not
  // on the last render's value.
  const camRef = useRef(cam);
  const setCamera = useCallback((next: Camera) => {
    camRef.current = next;
    setCam(next);
  }, []);
  /** Whether the camera has been placed for the frame yet (read by `bun run test:live`). */
  const [placed, setPlaced] = useState(false);
  const [selected, setSelected] = useState<string | null>(select ?? null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** Set when a press selects; null when a card is selected without one, until the camera is placed. */
  const [detailsSide, setDetailsSide] = useState<Side | null>(null);
  /** The world's fade and zoom while a level opens or closes. */
  const [motion, setMotion] = useState({ moving: false, hidden: false });
  /** The card to select, and flash, on the level above once an `upTo` card has gone up. */
  const arriving = useRef<string | null>(null);
  const drag = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    /** Whether the press began on a card, which a press without movement selects. */
    onCard: boolean;
    pointerId: number;
  } | null>(null);
  /** Set by a drag's release so the click the browser may send after it does not select or open. */
  const suppressClick = useRef(false);
  /** Finishes the level change in flight at once; null when none is. */
  const transition = useRef<(() => void) | null>(null);
  const reduced = useReducedMotion();
  const moving = flow && !reduced;
  const touring = moving && level.tour.length > 1;
  useTour(level, touring, dot, cardEls);
  useEffect(() => {
    onDrawn?.(true);
    return () => onDrawn?.(false);
  }, [onDrawn]);

  const settle = useCallback(
    () => setMotion((was) => (was.moving ? { ...was, moving: false } : was)),
    [],
  );
  /** Hands the camera to the person: a level change in flight finishes now, and no motion is left. */
  const takeCamera = useCallback(() => {
    transition.current?.();
    settle();
  }, [settle]);

  /** Puts the camera where the level opens, and docks the details of a card selected without a press. */
  const placeCamera = useCallback(
    (next: Camera, frame: { width: number; height: number }) => {
      setCamera(next);
      setPlaced(true);
      const { level } = levelRef.current;
      const card = level.cards.find((c) => c.id === selectedRef.current);
      if (card === undefined) return;
      setDetailsSide((was) => was ?? sideAway(cardCentre(level, card, next), frame));
    },
    [setCamera],
  );

  /** The Fit control: the whole level in the frame as it is now, see `fitCamera`. */
  const fit = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    takeCamera();
    setCamera(
      fitCamera(map, levelRef.current.level, { width: el.clientWidth, height: el.clientHeight }),
    );
    setPlaced(true);
  }, [map, takeCamera, setCamera]);

  /**
   * The frame's height for its width: the map's height at the scale that fits its width, so the
   * opening camera leaves no empty bands (owner, PR #326 review), and the phone frame below `PHONE`.
   */
  const [frameHeight, setFrameHeight] = useState(MIN_FRAME);
  const opened = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    const width = el.clientWidth;
    if (width >= PHONE) {
      const height = heroFrameHeight(rootWorld, width);
      setFrameHeight(height);
      if (el.offsetHeight === height) {
        const frame = { width, height: el.clientHeight };
        placeCamera(openCamera(map, levelRef.current.level, frame), frame);
      }
      return;
    }
    setFrameHeight(PHONE_FRAME);
    if (el.offsetHeight !== PHONE_FRAME) return;
    const { level, world } = levelRef.current;
    const at = phoneCentre(level, world);
    placeCamera(
      {
        k: PHONE_SCALE,
        x: width / 2 - at[0] * PHONE_SCALE,
        y: (PHONE_FRAME - FIT_FOOT) / 2 - at[1] * PHONE_SCALE,
      },
      { width, height: PHONE_FRAME },
    );
  }, [map, rootWorld, placeCamera]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    opened();
    const observer = new ResizeObserver(() => opened());
    observer.observe(el);
    return () => observer.disconnect();
  }, [opened]);

  const zoomAround = useCallback(
    (factor: number, mx: number, my: number) => {
      takeCamera();
      const was = camRef.current;
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, was.k * factor));
      setCamera({ k, x: mx - (mx - was.x) * (k / was.k), y: my - (my - was.y) * (k / was.k) });
    },
    [takeCamera, setCamera],
  );

  // A wheel listener React would attach passive, and a passive one cannot keep the page still.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // The details panel scrolls itself.
      if (event.target instanceof Element && event.target.closest('[data-map-details]')) return;
      event.preventDefault();
      const box = el.getBoundingClientRect();
      // A trackpad's two-finger swipe pans; a wheel, or a pinch (ctrl), zooms.
      const swipe =
        !event.ctrlKey &&
        (Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
          (event.deltaMode === 0 && Math.abs(event.deltaY) < 40 && event.deltaY % 1 !== 0));
      if (swipe) {
        takeCamera();
        const was = camRef.current;
        setCamera({ ...was, x: was.x - event.deltaX, y: was.y - event.deltaY });
        return;
      }
      zoomAround(
        Math.exp(-event.deltaY * 0.0022),
        event.clientX - box.left,
        event.clientY - box.top,
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround, takeCamera, setCamera]);

  // Esc, and Backspace outside a field: deselect first, else go up a level.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' && !(event.key === 'Backspace' && !typing(event.target))) return;
      if (selected !== null) setSelected(null);
      else if (path.length > 0) onPath(path.slice(0, -1));
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, path, onPath]);

  // The address changed: zoom into the card that opens the new level, or fade back up, then swap.
  const key = path.join(PATH_SEP);
  const shownKey = useRef(shown.join(PATH_SEP));
  shownKey.current = shown.join(PATH_SEP);
  useEffect(() => {
    const from = shownKey.current;
    if (from === key) {
      setMotion((was) => (was.hidden || was.moving ? { moving: false, hidden: false } : was));
      opened();
      return;
    }
    const leaving = from === '' ? [] : from.split(PATH_SEP);
    const going = key === '' ? [] : key.split(PATH_SEP);
    const into = going.length > leaving.length;
    const next = levelOf(map, going);
    const nextWorld = worldSize(next);
    const el = stage.current;
    const arrive = () => {
      const target = arriving.current ?? openerOf(map, leaving.at(-1) ?? '', next)?.id;
      arriving.current = null;
      if (!into) flash(target === undefined ? undefined : cardEls.current.get(target));
    };
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      selectedRef.current = arriving.current;
      setSelected(arriving.current);
      setDetailsSide(null);
      levelRef.current = { level: next, world: nextWorld };
      setShown(going);
    };
    let finish: (() => void) | undefined;
    const timers: number[] = [];
    const frames: number[] = [];
    const later = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms));
    const cancel = () => {
      for (const timer of timers) window.clearTimeout(timer);
      for (const frame of frames) cancelAnimationFrame(frame);
    };
    if (reduced || !el || drag.current?.moved) {
      swap();
      later(0, () => {
        opened();
        arrive();
      });
    } else {
      const card = into ? openerOf(map, going.at(-1) ?? '', levelRef.current.level) : undefined;
      setMotion({ moving: true, hidden: true });
      if (card) {
        const cx = card.x + cardWidth(levelRef.current.level, card) / 2;
        const cy = card.y + levelRef.current.level.cardSize.height / 2;
        setCamera({
          k: ZOOM_IN,
          x: el.clientWidth / 2 - cx * ZOOM_IN,
          y: (el.clientHeight - FIT_FOOT) / 2 - cy * ZOOM_IN,
        });
      }
      finish = () => {
        cancel();
        transition.current = null;
        swap();
        setMotion({ moving: false, hidden: false });
        opened();
        arrive();
      };
      transition.current = finish;
      later(SWAP_MS, () => {
        swap();
        const k = into ? ENTER_SCALE : LEAVE_SCALE;
        setMotion({ moving: false, hidden: true });
        setCamera({
          k,
          x: (el.clientWidth - nextWorld.width * k) / 2,
          y: (el.clientHeight - FIT_FOOT - nextWorld.height * k) / 2,
        });
        frames.push(
          requestAnimationFrame(() =>
            frames.push(
              requestAnimationFrame(() => {
                setMotion({ moving: true, hidden: false });
                opened();
              }),
            ),
          ),
        );
      });
      later(SWAP_MS + SETTLE_MS, settle);
      later(FLASH_MS, () => {
        transition.current = null;
        arrive();
      });
    }
    return () => {
      cancel();
      if (transition.current === finish) transition.current = null;
    };
  }, [key, map, reduced, opened, settle, setCamera]);

  const zoomCentre = (factor: number) => {
    const box = stage.current?.getBoundingClientRect();
    if (box) zoomAround(factor, box.width / 2, box.height / 2);
  };

  const selectCard = (id: string, press?: Point) => {
    const box = stage.current?.getBoundingClientRect();
    if (box) {
      const at: Point = press
        ? [press[0] - box.left, press[1] - box.top]
        : cardCentre(
            levelRef.current.level,
            levelRef.current.level.cards.find((c) => c.id === id) as Card,
            camRef.current,
          );
      setDetailsSide(sideAway(at, box));
    }
    setSelected(id);
  };

  const pan = (dx: number, dy: number) => {
    const was = camRef.current;
    setCamera({ ...was, x: was.x + dx, y: was.y + dy });
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    suppressClick.current = false;
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      onCard: event.target instanceof Element && event.target.closest('[data-card]') !== null,
      pointerId: event.pointerId,
    };
  };
  // Capture waits for the press to move: captured at once, the click of a plain press on a card
  // would go to the frame, not the card.
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const was = drag.current;
    if (!was) return;
    if (!was.moved) {
      if (
        Math.abs(event.clientX - was.startX) + Math.abs(event.clientY - was.startY) <=
        DRAG_SLOP
      ) {
        return;
      }
      was.moved = true;
      event.currentTarget.setPointerCapture(was.pointerId);
      takeCamera();
      pan(event.clientX - was.startX, event.clientY - was.startY);
    } else {
      pan(event.clientX - was.lastX, event.clientY - was.lastY);
    }
    was.lastX = event.clientX;
    was.lastY = event.clientY;
  };
  const onPointerUp = () => {
    const was = drag.current;
    drag.current = null;
    if (!was) return;
    if (was.moved) {
      // The click a browser sends after a drag comes straight after this event, or not at all.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    } else if (!was.onCard) setSelected(null);
  };

  const near = useMemo(() => neighbours(level, selected), [level, selected]);
  const lines = useMemo(
    () => level.lines.map((line) => ({ line, points: linePoints(level, line) })),
    [level],
  );
  const goUp = useCallback(
    (target: string) => {
      arriving.current = target;
      onPath(path.slice(0, -1));
    },
    [path, onPath],
  );
  const anyOpens = allCards(map).some((c) => c.opens !== undefined);
  const crumbs = [
    { id: null, title: factory },
    ...path.map((id) => ({ id, title: openerOf(map, id)?.title ?? id })),
  ];
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);
  const selectedCard = level.cards.find((c) => c.id === selected);
  const worldStyle: CSSProperties = {
    width: world.width,
    height: world.height,
    transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`,
    transformOrigin: '0 0',
    opacity: motion.hidden ? 0 : 1,
    transition: motion.moving ? WORLD_MOTION : undefined,
  };

  return (
    <div className="flex flex-col">
      <div className={`${COLUMN} mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1`}>
        <nav
          aria-label="Map level"
          data-map-crumbs
          className="flex flex-wrap items-center gap-1 font-mono text-[13px]"
        >
          {crumbs.map((crumb, i) => (
            <span key={crumb.id ?? 'root'} className="flex items-center gap-1">
              {i > 0 ? <span className="text-[color:var(--v3-fg-2)]">›</span> : null}
              <button
                type="button"
                data-crumb={crumb.id ?? 'root'}
                aria-current={i === path.length ? 'page' : undefined}
                disabled={i === path.length}
                onClick={() => onPath(path.slice(0, i))}
                className={`rounded-md px-2 py-0.5 ${
                  i === path.length
                    ? 'bg-[var(--v3-raised)] text-[color:var(--v3-fg)]'
                    : 'cursor-pointer text-[color:var(--v3-fg-2)] hover:bg-[var(--v3-raised)] hover:text-[color:var(--v3-fg)]'
                }`}
              >
                {crumb.title}
              </button>
            </span>
          ))}
        </nav>
        {aside}
      </div>
      <p data-map-caption className={`${COLUMN} mb-3 text-sm text-[color:var(--v3-fg-2)]`}>
        {level.caption}
      </p>
      <section
        ref={stage}
        aria-label="Factory map. Drag to move, scroll to zoom, click a step for details."
        data-map-stage
        data-view={shown.at(-1) ?? 'root'}
        data-flow={moving ? 'on' : 'off'}
        data-placed={placed || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.stopPropagation();
        }}
        className="relative mx-3 cursor-grab touch-none overflow-hidden rounded-xl border border-[color:var(--v3-line)] bg-[var(--v3-bg)] active:cursor-grabbing min-[701px]:mx-6"
        style={{
          height: frameHeight,
          // The one gradient on a surface the owner allows: the map frame's dot grid (#307).
          backgroundImage:
            'radial-gradient(color-mix(in srgb, var(--v3-fg-3) 28%, transparent) 1px, transparent 1.5px)',
          backgroundSize: '22px 22px',
        }}
      >
        <div data-map-world className="absolute top-0 left-0" style={worldStyle}>
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 overflow-visible"
            width={world.width}
            height={world.height}
          >
            <defs>
              {(Object.keys(LINE_COLOR) as LineStyle[]).map((style) => (
                <marker
                  key={style}
                  id={`map-arrow-${style}`}
                  viewBox="0 0 10 10"
                  refX={9}
                  refY={5}
                  markerWidth={7}
                  markerHeight={7}
                  orient="auto-start-reverse"
                >
                  <path d="M0,1 L9,5 L0,9 z" fill={LINE_COLOR[style]} />
                </marker>
              ))}
            </defs>
            {lines.map(({ line, points }) => {
              const hot = selected !== null && (line.from === selected || line.to === selected);
              return (
                <Wire
                  key={`${line.from}-${line.to}`}
                  line={line}
                  points={points}
                  hot={hot}
                  dimmed={selected !== null && !hot}
                  flow={moving}
                />
              );
            })}
            {lines.map(({ line, points }) =>
              line.label === undefined ? null : (
                <WireLabel
                  key={`label-${line.from}-${line.to}`}
                  text={line.label}
                  at={midpoint(points)}
                />
              ),
            )}
            {touring ? (
              <circle
                ref={dot}
                data-tour
                r={9}
                cx={-20}
                cy={-20}
                fill={stateColor('running')}
                className="motion-reduce:hidden"
              />
            ) : null}
          </svg>
          {level.group ? (
            <div
              data-map-group
              className="pointer-events-none absolute rounded-[14px] border border-dashed border-[color:var(--v3-line-2)]"
              style={{
                left: level.group.x,
                top: level.group.y,
                width: level.group.width,
                height: level.group.height,
              }}
            >
              <span
                data-group-label
                className="absolute right-5 bg-[var(--v3-bg)] px-2 font-mono uppercase leading-none tracking-[0.06em] text-[color:var(--v3-fg-2)]"
                style={{ fontSize: MAP_TYPE.label, top: -MAP_TYPE.label / 2 - 1 }}
              >
                {level.group.label}
              </span>
            </div>
          ) : null}
          {level.cards.map((card) => (
            <MapCard
              key={card.id}
              map={level}
              card={card}
              live={live.get(card.id)}
              state={
                selected === null
                  ? 'plain'
                  : card.id === selected
                    ? 'selected'
                    : near.has(card.id)
                      ? 'near'
                      : 'dim'
              }
              onSelect={selectCard}
              onOpen={(view) => onPath([...path, view])}
              onUp={goUp}
              register={register}
            />
          ))}
        </div>
        <div
          data-map-hint
          className="pointer-events-none absolute bottom-3 left-3 hidden rounded-lg border border-[color:var(--v3-line)] bg-[var(--v3-panel)] px-[9px] py-[5px] font-mono text-[11px] text-[color:var(--v3-fg-2)] min-[701px]:block"
        >
          drag = move · scroll = zoom · click = details · double-click ⤢ = open · Esc = up
        </div>
        <div
          data-map-controls
          onPointerDown={(event) => event.stopPropagation()}
          className="absolute right-3 bottom-3 flex gap-1 rounded-[9px] border border-[color:var(--v3-line)] bg-[var(--v3-panel)] p-1"
        >
          <button
            type="button"
            data-map-up
            disabled={path.length === 0}
            onClick={() => onPath(path.slice(0, -1))}
            aria-label="Up a level"
            title="Up a level"
            className={CONTROL}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => zoomCentre(1 / 1.3)}
            className={CONTROL}
          >
            −
          </button>
          <button type="button" aria-label="Fit" title="Fit" onClick={fit} className={CONTROL}>
            fit
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => zoomCentre(1.3)}
            className={CONTROL}
          >
            +
          </button>
        </div>
        {selectedCard ? (
          <div
            data-map-details
            data-side={detailsSide ?? 'right'}
            onPointerDown={(event) => event.stopPropagation()}
            className="absolute z-10 cursor-auto touch-pan-y select-text overflow-y-auto overscroll-contain"
            style={detailsStyle(detailsSide ?? 'right')}
          >
            <MapDetails
              card={selectedCard}
              live={live.get(selectedCard.id)}
              factory={factory}
              at={at}
              steps={steps}
              stepsFailed={stepsFailed}
              onClose={() => setSelected(null)}
              open={
                selectedCard.opens === undefined
                  ? undefined
                  : {
                      title: selectedCard.title,
                      steps: map.views?.[selectedCard.opens]?.cards.length ?? 0,
                      onOpen: () => onPath([...path, selectedCard.opens as string]),
                    }
              }
            />
          </div>
        ) : null}
      </section>
      <ul
        data-map-legend
        className={`${COLUMN} mt-2.5 flex flex-wrap gap-x-[18px] gap-y-2 text-[12px] text-[color:var(--v3-fg-2)]`}
      >
        {map.legend.map((entry) => (
          <li key={entry.role} className="flex items-center">
            <span
              aria-hidden="true"
              className="mr-1.5 inline-block h-2.5 w-2.5 rounded-[3px]"
              style={{ background: ROLE_COLOR[entry.role] }}
            />
            {entry.label}
          </li>
        ))}
        {anyOpens ? (
          <li className="flex items-center">
            <span aria-hidden="true" className="mr-1.5 font-mono">
              ⤢
            </span>
            opens a deeper view
          </li>
        ) : null}
      </ul>
    </div>
  );
}
