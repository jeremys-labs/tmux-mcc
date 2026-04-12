import { useEffect, useRef, useState } from 'react';
import { Application } from 'pixi.js';
import { IsometricScene } from './IsometricScene';
import { preloadAllAvatars, destroyAvatarTextures } from './avatars';
import { useAgentStore } from '../stores/agentStore';
import { useUIStore } from '../stores/uiStore';

export function OfficeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef<IsometricScene | null>(null);
  const agents = useAgentStore((s) => s.agents);
  const openAgentPanel = useUIStore((s) => s.openAgentPanel);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || Object.keys(agents).length === 0) return;

    const container = containerRef.current;
    let destroyed = false;
    let app: Application | null = null;

    (async () => {
      try {
        app = new Application();

        await app.init({
          background: 0x1a1a2e,
          antialias: true,
          width: container.clientWidth,
          height: container.clientHeight,
        });

        if (destroyed) {
          app.destroy(true);
          return;
        }

        appRef.current = app;
        container.appendChild(app.canvas);

        const avatarTextures = await preloadAllAvatars(agents);

        if (destroyed) {
          destroyAvatarTextures();
          app.destroy(true);
          return;
        }

        const scene = new IsometricScene(app, agents, avatarTextures);
        sceneRef.current = scene;

        scene.on('agentClick', (agentKey: string) => {
          openAgentPanel(agentKey);
        });

        scene.render();

        // Handle container resize
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry && appRef.current) {
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0) {
              appRef.current.renderer.resize(width, height);
            }
          }
        });
        observer.observe(container);

        // Store observer ref for cleanup
        (container as unknown as Record<string, unknown>)._resizeObserver = observer;
      } catch (err) {
        console.error('[OfficeCanvas] Init error:', err);
        setInitError(err instanceof Error ? err.message : 'Failed to initialize canvas');
      }
    })();

    return () => {
      destroyed = true;

      // Clean up resize observer
      const obs = (container as unknown as Record<string, unknown>)._resizeObserver as ResizeObserver | undefined;
      if (obs) {
        obs.disconnect();
        delete (container as unknown as Record<string, unknown>)._resizeObserver;
      }

      if (sceneRef.current) {
        sceneRef.current.destroy();
        sceneRef.current = null;
      }

      destroyAvatarTextures();

      if (appRef.current) {
        try {
          // Remove canvas from DOM before destroy to avoid _cancelResize errors
          if (appRef.current.canvas?.parentNode) {
            appRef.current.canvas.parentNode.removeChild(appRef.current.canvas);
          }
          appRef.current.destroy(true);
        } catch {
          // PixiJS destroy can throw in some edge cases — safe to ignore
        }
        appRef.current = null;
      }
    };
  }, [agents, openAgentPanel]);

  if (initError) {
    return (
      <div className="w-full h-full flex items-center justify-center text-red-400">
        Canvas error: {initError}
      </div>
    );
  }

  return <div ref={containerRef} className="w-full h-full" />;
}
