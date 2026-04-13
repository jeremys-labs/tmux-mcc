import { useState, useCallback, useEffect, useRef } from 'react';

interface Props {
  left: React.ReactNode;
  right: React.ReactNode;
  rightVisible: boolean;
  defaultRightWidth?: number;
}

export function ResizableSplit({ left, right, rightVisible, defaultRightWidth = 400 }: Props) {
  const [rightWidth, setRightWidth] = useState(defaultRightWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const startDrag = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = rightWidth;
    e.preventDefault();
  }, [rightWidth]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const delta = startX.current - e.clientX;
      setRightWidth(Math.max(200, Math.min(900, startWidth.current + delta)));
    }
    function onMouseUp() {
      dragging.current = false;
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex-1 overflow-hidden min-w-0">
        {left}
      </div>
      {rightVisible && (
        <>
          <div
            className="w-1 shrink-0 bg-white/10 hover:bg-accent cursor-col-resize transition-colors"
            onMouseDown={startDrag}
          />
          <div style={{ width: rightWidth }} className="shrink-0 overflow-hidden">
            {right}
          </div>
        </>
      )}
    </div>
  );
}
