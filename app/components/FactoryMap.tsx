import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type Card,
  cardWidth,
  type FactoryMap as FactoryMapData,
  type Line,
  type LineStyle,
  linePoints,
  midpoint,
  neighbours,
  type Point,
  pathOf,
  type Role,
  tourPoints,
  worldSize,
} from '../map/factory-map';
import type { StepRow } from '../lib/step-detail';
import type { CardLive } from '../map/live';
import { MapDetails } from './MapDetails';

const ROLE_COLOR: Record<Role, string> = {
  source: 'var(--role-source)',
  agent: 'var(--role-agent)',
  test: 'var(--role-test)',
  person: 'var(--role-person)',
};

/** A color over transparent, so every rendered color stays a token (harness/design-probe.js). */
const over = (color: string, amount: string) =>
  `color-mix(in srgb, ${color} ${amount}, transparent)`;

const LINE_COLOR: Record<LineStyle, string> = {
  flow: 'var(--text-tertiary)',
  loop: 'var(--text-tertiary)',
  ask: 'var(--role-person)',
  holdout: 'var(--role-test)',
};
const LINE_DASH: Record<LineStyle, string | undefined> = {
  flow: undefined,
  loop: '6 5',
  ask: '3 4',
  holdout: '2 4',
};

/**
 * The map's type in map units, larger than the mockup's so that at 1440 wide, fitted, a card's
 * title renders at least 14px, its text 11px and the labels 10px (owner, PR #326 review).
 */
export const MAP_TYPE = { kind: 18, title: 25, text: 20, chip: 15, label: 18 } as const;
/** A wire label's Geist Mono advance per character, 0.6em, rounded up. */
const LABEL_CHAR_W = Math.ceil(MAP_TYPE.label * 0.6);
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.4;
/** The fit's margin around the map, in pixels. */
const FIT_PAD = 16;
/** Room the fit keeps under the map for the hint and the controls. */
const FIT_FOOT = 48;
/** The frame's least height (owner, PR #326 review). */
const MIN_FRAME = 420;
/** The largest scale a fit uses. */
const FIT_MAX = 1.15;
/**
 * Below this width the map opens as refs/40-home-phone.png draws it: the line at a readable scale,
 * centred between Review and App check, the rest a pan away. Fit still fits the whole map.
 */
const PHONE = 701;
const PHONE_SCALE = 0.42;
const PHONE_FRAME = 460;

interface Camera {
  x: number;
  y: number;
  k: number;
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
  map: FactoryMapData,
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
        if (card) {
          card.classList.remove('animate-map-hit');
          void card.offsetWidth;
          card.classList.add('animate-map-hit');
        }
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
const phoneCentre = ({ group }: FactoryMapData): Point => [
  group.x + group.width / 2,
  (group.y + group.height) / 2,
];

function chipsOf(live: CardLive | undefined) {
  if (live === undefined) return [];
  const chips: { chip: string; text: string; className: string; pulse?: boolean }[] = [];
  const add = (chip: string, n: number | undefined, word: string, className: string) => {
    if (n) chips.push({ chip, text: `${n} ${word}`, className, pulse: chip === 'here' });
  };
  add(
    'here',
    live.here.length,
    'here',
    'bg-[color:var(--accent-soft)] text-[color:var(--running)]',
  );
  add('queued', live.queued?.length, 'queued', 'bg-surface-hover text-text-primary');
  add(
    'failing',
    live.failing?.length,
    'failing',
    'bg-[color:var(--error-soft)] text-[color:var(--error)]',
  );
  add(
    'waiting',
    live.waiting?.length,
    'waiting',
    'bg-[color:var(--role-person-soft)] text-[color:var(--role-person)]',
  );
  add(
    'merged',
    live.merged?.length,
    'merged',
    'bg-[color:var(--role-test-soft)] text-[color:var(--role-test)]',
  );
  return chips;
}

function MapCard({
  map,
  card,
  live,
  state,
  onSelect,
  register,
}: {
  map: FactoryMapData;
  card: Card;
  live: CardLive | undefined;
  state: 'selected' | 'near' | 'dim' | 'plain';
  onSelect: (id: string) => void;
  register: (id: string, el: HTMLElement | null) => void;
}): ReactElement {
  const color = ROLE_COLOR[card.role];
  const chips = chipsOf(live);
  const counts = chips.map((c) => c.text).join(', ');
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect(card.id);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holds blocks, which a <button> may not
    <div
      ref={(el) => register(card.id, el)}
      role="button"
      tabIndex={0}
      aria-pressed={state === 'selected'}
      aria-label={`${card.title}. ${card.text}${counts ? `. ${counts}` : ''}`}
      data-card={card.id}
      data-role={card.role}
      data-live-count={live?.here.length ?? 0}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(card.id);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={onKey}
      data-selected={state === 'selected' || undefined}
      className={`absolute cursor-pointer select-none rounded-[16px] border-2 bg-surface-elevated pt-3 pr-3 pb-3 pl-4 transition-[opacity,box-shadow,border-color] duration-200 ${
        state === 'selected' ? '' : 'hover:border-[color:var(--text-secondary)]'
      } ${state === 'dim' ? 'opacity-30' : ''} ${
        state === 'selected' ? 'shadow-[0_0_0_7px_var(--accent)]' : ''
      }`}
      style={{
        left: card.x,
        top: card.y,
        width: cardWidth(map, card),
        height: map.cardSize.height,
        borderColor:
          state === 'selected' ? 'var(--surface)' : over(color, 'var(--card-border-tint)'),
      }}
    >
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
          className="mt-1 font-semibold leading-[1.15] text-text-primary"
          style={{ fontSize: MAP_TYPE.title }}
        >
          {card.title}
        </span>
        <span
          data-card-text
          className="mt-1.5 leading-[1.3] text-text-secondary"
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
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 font-mono tabular-nums ${c.className}`}
                style={{ fontSize: MAP_TYPE.chip }}
              >
                {c.pulse ? (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full bg-[color:var(--running)] motion-safe:animate-pulse"
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
          stroke="var(--accent)"
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
        fill="var(--surface)"
      />
      <text
        x={at[0]}
        y={at[1] - 3 - height / 2}
        dominantBaseline="central"
        textAnchor="middle"
        className="font-mono"
        fontSize={MAP_TYPE.label}
        fill="var(--text-secondary)"
      >
        {text}
      </text>
    </g>
  );
}

/** The app's column, which the caption, legend and details keep while the map spans the window. */
const COLUMN = 'mx-auto w-full max-w-6xl px-6';

const CONTROL =
  'cursor-pointer rounded-md px-[9px] py-1 font-mono text-[12px] text-text-secondary hover:bg-surface-elevated hover:text-text-primary disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text-secondary';

/**
 * The factory map's root view (PRD 4.1): the owner's drawing with live chips on its cards, a camera
 * that pans, zooms around the cursor and fits the stage, and a details strip for the card clicked.
 * `flow` off, or `prefers-reduced-motion`, stops the travelling dot and the flowing dashes.
 */
export function FactoryMap({
  map,
  live,
  factory,
  at,
  flow,
  onDrawn,
  steps,
}: {
  map: FactoryMapData;
  live: ReadonlyMap<string, CardLive>;
  factory: string;
  at: string | null;
  flow: boolean;
  /** Told true once the map is on the page and false when it leaves, for the flow toggle. */
  onDrawn?: (drawn: boolean) => void;
  /** The pinned version's steps, for Behind the scenes; undefined until they arrive. */
  steps?: readonly StepRow[];
}): ReactElement {
  const world = useMemo(() => worldSize(map), [map]);
  const stage = useRef<HTMLElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const cardEls = useRef(new Map<string, HTMLElement>());
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, k: 0.5 });
  /** Whether the camera has been placed for the frame yet (read by `bun run test:live`). */
  const [placed, setPlaced] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; cam: Camera; moved: boolean } | null>(null);
  const reduced = useReducedMotion();
  const moving = flow && !reduced;
  useTour(map, moving, dot, cardEls);
  useEffect(() => {
    onDrawn?.(true);
    return () => onDrawn?.(false);
  }, [onDrawn]);

  /** The whole map in the frame, centred, as large as both of the frame's sides allow. */
  const fit = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    const { clientWidth: width, clientHeight: height } = el;
    const k = Math.min(
      (width - FIT_PAD * 2) / world.width,
      (height - FIT_PAD * 2 - FIT_FOOT) / world.height,
      FIT_MAX,
    );
    setCam({
      k,
      x: (width - world.width * k) / 2,
      y: Math.max(FIT_PAD, (height - FIT_FOOT - world.height * k) / 2),
    });
    setPlaced(true);
  }, [world]);

  /**
   * The frame's height for its width: the map's height at the scale that fits its width, so a fit
   * leaves no empty bands (owner, PR #326 review), and the phone frame below `PHONE`.
   */
  const [frameHeight, setFrameHeight] = useState(MIN_FRAME);
  const opened = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    const width = el.clientWidth;
    if (width >= PHONE) {
      const k = Math.min((width - FIT_PAD * 2) / world.width, FIT_MAX);
      const height = Math.max(MIN_FRAME, Math.ceil(world.height * k + FIT_PAD * 2 + FIT_FOOT));
      setFrameHeight(height);
      if (el.offsetHeight === height) fit();
      return;
    }
    setFrameHeight(PHONE_FRAME);
    if (el.offsetHeight !== PHONE_FRAME) return;
    const at = phoneCentre(map);
    setCam({
      k: PHONE_SCALE,
      x: width / 2 - at[0] * PHONE_SCALE,
      y: (PHONE_FRAME - FIT_FOOT) / 2 - at[1] * PHONE_SCALE,
    });
    setPlaced(true);
  }, [map, world, fit]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    opened();
    const observer = new ResizeObserver(() => opened());
    observer.observe(el);
    return () => observer.disconnect();
  }, [opened]);

  const zoomAround = useCallback((factor: number, mx: number, my: number) => {
    setCam((was) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, was.k * factor));
      return { k, x: mx - (mx - was.x) * (k / was.k), y: my - (my - was.y) * (k / was.k) };
    });
  }, []);

  // A wheel listener React would attach passive, and a passive one cannot keep the page still.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = el.getBoundingClientRect();
      // A trackpad's two-finger swipe pans; a wheel, or a pinch (ctrl), zooms.
      const swipe =
        !event.ctrlKey &&
        (Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
          (event.deltaMode === 0 && Math.abs(event.deltaY) < 40 && event.deltaY % 1 !== 0));
      if (swipe) {
        setCam((was) => ({ ...was, x: was.x - event.deltaX, y: was.y - event.deltaY }));
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
  }, [zoomAround]);

  useEffect(() => {
    if (selected === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const zoomCentre = (factor: number) => {
    const box = stage.current?.getBoundingClientRect();
    if (box) zoomAround(factor, box.width / 2, box.height / 2);
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    drag.current = { x: event.clientX, y: event.clientY, cam, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const was = drag.current;
    if (!was) return;
    const dx = event.clientX - was.x;
    const dy = event.clientY - was.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) was.moved = true;
    setCam({ ...was.cam, x: was.cam.x + dx, y: was.cam.y + dy });
  };
  const onPointerUp = () => {
    if (drag.current && !drag.current.moved) setSelected(null);
    drag.current = null;
  };

  const near = useMemo(() => neighbours(map, selected), [map, selected]);
  const lines = useMemo(
    () => map.lines.map((line) => ({ line, points: linePoints(map, line) })),
    [map],
  );
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);
  const selectedCard = map.cards.find((c) => c.id === selected);
  const worldStyle: CSSProperties = {
    width: world.width,
    height: world.height,
    transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`,
    transformOrigin: '0 0',
  };

  return (
    <div className="flex flex-col">
      <p data-map-caption className={`${COLUMN} mb-3 text-sm text-text-secondary`}>
        {map.caption}
      </p>
      <section
        ref={stage}
        aria-label="Factory map. Drag to move, scroll to zoom, click a step for details."
        data-map-stage
        data-flow={moving ? 'on' : 'off'}
        data-placed={placed || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        className="relative mx-3 cursor-grab touch-none overflow-hidden rounded-xl border border-border bg-surface active:cursor-grabbing min-[701px]:mx-6"
        style={{
          height: frameHeight,
          // The one gradient on a surface the owner allows: the map frame's dot grid (#307).
          backgroundImage:
            'radial-gradient(color-mix(in srgb, var(--text-tertiary) 28%, transparent) 1px, transparent 1.5px)',
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
            {moving ? (
              <circle
                ref={dot}
                data-tour
                r={9}
                cx={-20}
                cy={-20}
                fill="var(--running)"
                className="motion-reduce:hidden"
              />
            ) : null}
          </svg>
          <div
            data-map-group
            className="pointer-events-none absolute rounded-[14px] border border-dashed border-[color:var(--border-bright)]"
            style={{
              left: map.group.x,
              top: map.group.y,
              width: map.group.width,
              height: map.group.height,
            }}
          >
            <span
              data-group-label
              className="absolute left-5 bg-surface px-2 font-mono uppercase leading-none tracking-[0.06em] text-text-secondary"
              style={{ fontSize: MAP_TYPE.label, top: -MAP_TYPE.label / 2 - 1 }}
            >
              {map.group.label}
            </span>
          </div>
          {map.cards.map((card) => (
            <MapCard
              key={card.id}
              map={map}
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
              onSelect={setSelected}
              register={register}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 hidden rounded-lg border border-border bg-surface px-[9px] py-[5px] font-mono text-[11px] text-text-secondary min-[701px]:block">
          drag = move · scroll = zoom · click = details · Esc = deselect
        </div>
        <div
          data-map-controls
          onPointerDown={(event) => event.stopPropagation()}
          className="absolute right-3 bottom-3 flex gap-1 rounded-[9px] border border-border bg-surface p-1"
        >
          <button
            type="button"
            disabled
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
      </section>
      <ul
        data-map-legend
        className={`${COLUMN} mt-2.5 flex flex-wrap gap-x-[18px] gap-y-2 text-[12px] text-text-secondary`}
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
      </ul>
      {selectedCard ? (
        <MapDetails
          className={COLUMN}
          card={selectedCard}
          live={live.get(selectedCard.id)}
          factory={factory}
          at={at}
          steps={steps}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
