import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

/** Width of the revealed action, kept in sync with `.swipe-action` in CSS. */
export const SWIPE_ACTION_WIDTH = 88;
const DRAG_START_PX = 8;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  base: number;
  active: boolean;
}

/**
 * A row that can be dragged left to reveal one destructive action. Pointer
 * events plus `touch-action: pan-y` let the page keep vertical scrolling while
 * horizontal gestures are handled here. Tapping an open row closes it.
 */
export function SwipeRow({
  open,
  onOpenChange,
  action,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: ReactNode;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(open ? -SWIPE_ACTION_WIDTH : 0);
  const [dragging, setDragging] = useState(false);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (drag.current) return;
    setOffset(open ? -SWIPE_ACTION_WIDTH : 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent): void => {
      const row = rowRef.current;
      if (row && event.target instanceof Node && row.contains(event.target)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open, onOpenChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: offsetRef.current,
      active: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.active) {
      if (Math.abs(dx) < DRAG_START_PX && Math.abs(dy) < DRAG_START_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        // The page is scrolling; leave this gesture alone.
        drag.current = null;
        return;
      }
      state.active = true;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setOffset(Math.min(0, Math.max(-SWIPE_ACTION_WIDTH - 16, state.base + dx)));
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    drag.current = null;
    setDragging(false);
    if (!state || state.pointerId !== event.pointerId || !state.active) return;
    // The release still produces a click; it must not open the run.
    suppressClick.current = true;
    const settleOpen = offsetRef.current <= -SWIPE_ACTION_WIDTH / 2;
    setOffset(settleOpen ? -SWIPE_ACTION_WIDTH : 0);
    if (settleOpen !== open) onOpenChange(settleOpen);
  };

  const cancel = (): void => {
    drag.current = null;
    setDragging(false);
    setOffset(open ? -SWIPE_ACTION_WIDTH : 0);
  };

  return (
    <div
      ref={rowRef}
      className="swipe-row"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={cancel}
    >
      <div className="swipe-action">{action}</div>
      <div
        className={`swipe-content${dragging ? ' dragging' : ''}`}
        style={{ transform: `translateX(${offset}px)` }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (open) {
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
