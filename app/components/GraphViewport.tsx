import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/** Keep full-size graph nodes readable and make overflow discoverable without changing a graph that fits. */
export function GraphViewport({
  children,
  label,
  anchorX,
  className = 'rounded-lg',
}: {
  children: ReactNode;
  label: string;
  anchorX: number;
  className?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const previousWidth = useRef(0);
  const [directions, setDirections] = useState({ left: false, right: false });

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => {
      // Recenter on opening or resizing, never on a live count/state update or a manual scroll.
      if (previousWidth.current !== element.clientWidth) {
        element.scrollLeft = Math.max(0, anchorX - element.clientWidth / 2);
        previousWidth.current = element.clientWidth;
      }
      setDirections({
        left: element.scrollLeft > 1,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', update);
    };
  }, [anchorX]);

  return (
    <div className={className}>
      {directions.left || directions.right ? (
        <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[11px] text-text-secondary">
          <span>Scroll to see more</span>
          <div className="flex gap-2">
            {(['left', 'right'] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                aria-label={`Scroll ${label} ${direction}`}
                disabled={!directions[direction]}
                className="rounded border border-border-bright bg-surface-elevated px-3 py-1 enabled:hover:brightness-110 disabled:opacity-50"
                onClick={() => {
                  const element = viewport.current;
                  if (element) {
                    element.scrollBy({
                      left: element.clientWidth * (direction === 'left' ? -0.8 : 0.8),
                    });
                  }
                }}
              >
                {direction === 'left' ? '←' : '→'}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div
        ref={viewport}
        className="overflow-x-auto rounded-[inherit] border border-border bg-surface"
      >
        {children}
      </div>
    </div>
  );
}
