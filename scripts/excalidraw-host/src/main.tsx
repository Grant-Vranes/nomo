import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

type LoadedPayload = {
  type: 'nomo:load';
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

function serialize(
  elements: readonly unknown[],
  files: Record<string, unknown>,
): string {
  return JSON.stringify({ type: 'excalidraw', version: 2, source: 'nomo', elements, appState: {}, files });
}

function App() {
  const [excalidrawAPI, setExcalidrawAPI] = useState<any>(null);
  const baselineRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<string | null>(null);
  const apiRef = useRef<any>(null);

  apiRef.current = excalidrawAPI;

  useEffect(() => {
    if (!excalidrawAPI) return;
    // 通知宿主：编辑器就绪，可以加载初始内容。
    window.parent.postMessage({ type: 'nomo:ready' }, '*');

    const onMessage = (event: MessageEvent) => {
      const data = event.data as LoadedPayload | { type: 'nomo:saved'; snapshot?: string } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'nomo:load') {
        const payload = data as LoadedPayload;
        excalidrawAPI.updateScene({ elements: payload.elements ?? [] });
        if (payload.files) {
          excalidrawAPI.addFiles(Object.values(payload.files) as any[]);
        }
        baselineRef.current = null; // 下一次 change 作为基线
      } else if (data.type === 'nomo:saved') {
        const saved = data as { type: 'nomo:saved'; snapshot?: string };
        if (typeof saved.snapshot === 'string') baselineRef.current = saved.snapshot;
      } else if (data.type === 'nomo:flush') {
        // 宿主主动请求当前快照（保存前强制 flush）。
        const snapshot = latestSnapshotRef.current;
        if (snapshot !== null) {
          window.parent.postMessage({ type: 'nomo:change', snapshot }, '*');
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [excalidrawAPI]);

  return (
    <div style={{ height: '100vh', width: '100vw' }}>
      <Excalidraw
        excalidrawAPI={setExcalidrawAPI}
        theme="light"
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
            clearCanvas: false,
            changeCanvasBackground: false,
          },
        }}
        onChange={(elements, _appState, files) => {
          const snapshot = serialize(elements, files as Record<string, unknown>);
          latestSnapshotRef.current = snapshot;
          if (baselineRef.current === null) {
            // 首份序列化作为基线，不误标脏。
            baselineRef.current = snapshot;
            return;
          }
          if (snapshot !== baselineRef.current) {
            window.parent.postMessage({ type: 'nomo:change', snapshot }, '*');
          }
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
