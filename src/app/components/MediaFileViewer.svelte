<script lang="ts">
  /**
   * 只读媒体查看器：图片（缩放/适配/1:1/旋转/另存为）、PDF（WebView 内置能力）、
   * HTML（沙箱 iframe 预览 + 源码视图）、Draw.io / Excalidraw（离线编辑器）。
   * 标签只保存路径，二进制永远不读成文本。
   */
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { onDestroy, onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { get, writable } from 'svelte/store';
  import type { MediaTabState } from '../types';
  import { createPerfTimer, logError } from '../../lib/services/logger';

  export let tab: MediaTabState;

  const ZOOM_STEP = 0.2;
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 8;

  let container: HTMLElement;
  let naturalWidth = 0;
  let naturalHeight = 0;
  let scale = 1;
  let rotation = 0;
  let panX = 0;
  let panY = 0;
  let panning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;
  let fitMode: 'fit' | 'actual' | 'custom' = 'fit';
  let htmlSource: string | null = null;
  let htmlSourceMode = false;
  let loadError: string | null = null;
  let mediaUrl = writable<string | null>(null);

  // ---- 画布编辑器（Draw.io / Excalidraw）状态 ----
  let editorFrame: HTMLIFrameElement | null = null;
  let canvasContent: string | null = null;
  let canvasReady = false;
  let canvasSaveState: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' = 'idle';
  let canvasSaveError: string | null = null;
  let lastSavedCanvasXml: string | null = null;
  let canvasSaveTimer: ReturnType<typeof setTimeout> | null = null;

  $: isDrawio = tab.mediaKind === 'drawio';
  $: isExcalidraw = tab.mediaKind === 'excalidraw';
  $: isCanvasEditor = isDrawio || isExcalidraw;

  /** 跨平台自定义协议 URL：Windows 上 WebView2 要求 http://<scheme>.localhost 形式。 */
  function offlineEditorUrl(scheme: string, query = ''): string {
    const isWindows = navigator.userAgent.includes('Windows');
    const origin = isWindows ? `http://${scheme}.localhost` : `${scheme}://localhost`;
    return `${origin}/index.html${query}`;
  }

  $: drawioEditorUrl = isDrawio
    ? offlineEditorUrl(
        'drawio-local',
        '?embed=1&proto=json&libraries=1&saveAndExit=0&noSaveBtn=1&checkForUpdates=0',
      )
    : '';
  $: excalidrawEditorUrl = isExcalidraw ? offlineEditorUrl('excalidraw-local') : '';

  $: if (tab.nativePath && isCanvasEditor) {
    void loadCanvasContent();
  }

  async function loadCanvasContent() {
    if (!tab.nativePath) return;
    canvasReady = false;
    canvasContent = null;
    canvasSaveState = 'idle';
    canvasSaveError = null;
    lastSavedCanvasXml = null;
    const timer = createPerfTimer('MediaViewer', '读取画布文件内容');
    try {
      const result = await invoke<{ content: string; sourceMode: boolean }>(
        'read_external_text_file',
        { path: tab.nativePath },
      );
      canvasContent = result.content;
      lastSavedCanvasXml = result.content;
      timer.end({ bytes: result.content.length });
    } catch (error) {
      // 损坏/无法识别的内容以空画布打开，不覆盖原文。
      canvasContent = '';
      lastSavedCanvasXml = '';
      canvasSaveState = 'error';
      canvasSaveError = error instanceof Error ? error.message : String(error);
      logError('MediaViewer', '画布文件读取失败', { error: canvasSaveError });
      timer.end({ error: canvasSaveError });
    }
  }

  function handleEditorMessage(event: MessageEvent) {
    if (!editorFrame || event.source !== editorFrame.contentWindow) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;
    if (isDrawio) {
      const kind = data.event;
      if (kind === 'init') {
        canvasReady = true;
        editorFrame.contentWindow?.postMessage(
          { action: 'load', xml: canvasContent ?? '', autosave: 1 },
          '*',
        );
      } else if (kind === 'save' || kind === 'exit' || kind === 'autosave') {
        if (typeof data.xml === 'string') scheduleCanvasSave(data.xml);
      } else if (kind === 'export') {
        // 手动“保存”按钮通过 export 动作拿回 XML。
        if (typeof data.data === 'string' && data.data) scheduleCanvasSave(data.data);
      }
    } else if (isExcalidraw) {
      const type = data.type;
      if (type === 'nomo:ready') {
        canvasReady = true;
        let elements: unknown[] = [];
        let files: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(canvasContent ?? '{}');
          elements = Array.isArray(parsed.elements) ? parsed.elements : [];
          files = parsed.files && typeof parsed.files === 'object' ? parsed.files : {};
        } catch {
          // 空画布：内容不可解析时不回填。
        }
        editorFrame.contentWindow?.postMessage({ type: 'nomo:load', elements, files }, '*');
      } else if (type === 'nomo:change' && typeof data.snapshot === 'string') {
        scheduleCanvasSave(data.snapshot);
      }
    }
  }

  /** 画布变更防抖写回磁盘（首份/与已保存内容一致时跳过）。 */
  function scheduleCanvasSave(content: string) {
    if (content === lastSavedCanvasXml) return;
    canvasSaveState = 'dirty';
    if (canvasSaveTimer) clearTimeout(canvasSaveTimer);
    canvasSaveTimer = setTimeout(() => void flushCanvasSave(content), 800);
  }

  async function flushCanvasSave(content: string) {
    if (canvasSaveTimer) {
      clearTimeout(canvasSaveTimer);
      canvasSaveTimer = null;
    }
    if (!tab.nativePath || content === lastSavedCanvasXml) return;
    canvasSaveState = 'saving';
    try {
      await invoke('write_canvas_file', { path: tab.nativePath, content });
      lastSavedCanvasXml = content;
      canvasSaveState = 'saved';
      if (isExcalidraw && editorFrame?.contentWindow) {
        editorFrame.contentWindow.postMessage({ type: 'nomo:saved', snapshot: content }, '*');
      }
    } catch (error) {
      canvasSaveState = 'error';
      canvasSaveError = error instanceof Error ? error.message : String(error);
      logError('MediaViewer', '画布保存失败', { error: canvasSaveError });
    }
  }

  type CanvasSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  const CANVAS_SAVE_STATE_TEXT: Record<CanvasSaveState, string> = {
    idle: '就绪',
    dirty: '有未保存更改',
    saving: '保存中…',
    saved: '已保存',
    error: '保存失败',
  };

  onDestroy(() => {
    if (canvasSaveTimer) clearTimeout(canvasSaveTimer);
  });

  $: isImage = tab.mediaKind === 'image';
  $: isPdf = tab.mediaKind === 'pdf';
  $: isHtml = tab.mediaKind === 'html';
  $: needsUrl = isImage || isPdf;
  $: if (tab.nativePath && needsUrl) {
    mediaUrl.set(convertFileSrc(tab.nativePath));
  }

  onMount(() => {
    if (isHtml) void loadHtmlSource();
  });

  async function loadHtmlSource() {
    if (!tab.nativePath) return;
    const timer = createPerfTimer('MediaViewer', '读取 HTML 预览源码');
    try {
      const result = await invoke<{ content: string; sourceMode: boolean }>(
        'read_external_text_file',
        { path: tab.nativePath },
      );
      htmlSource = result.content;
      htmlSourceMode = result.sourceMode;
      timer.end({ bytes: result.content.length, sourceMode: result.sourceMode });
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
      logError('MediaViewer', 'HTML 预览源码读取失败', { error: loadError });
      timer.end({ error: loadError });
    }
  }

  function toggleHtmlSource() {
    htmlSourceMode = !htmlSourceMode;
  }

  function handleImageLoad(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    naturalWidth = image.naturalWidth;
    naturalHeight = image.naturalHeight;
    if (fitMode !== 'custom') applyFit();
  }

  function applyFit() {
    if (!container || naturalWidth === 0) return;
    const available = container.clientWidth - 32;
    const availableHeight = container.clientHeight - 32;
    const ratio = Math.min(
      available / naturalWidth,
      availableHeight / naturalHeight,
      1,
    );
    scale = Math.max(ZOOM_MIN, ratio);
    fitMode = 'fit';
    panX = 0;
    panY = 0;
  }

  function applyActualSize() {
    scale = 1;
    fitMode = 'actual';
    panX = 0;
    panY = 0;
  }

  /** 以鼠标位置为锚点的滚轮缩放（Ctrl+滚轮或直接滚轮均可）。 */
  function handleWheel(event: WheelEvent) {
    if (!isImage || !container) return;
    event.preventDefault();
    const stage = event.currentTarget as HTMLElement;
    const direction = event.deltaY > 0 ? -1 : 1;
    const factor = direction > 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * factor));
    if (next === scale) return;
    // 光标相对图片中心的坐标（含当前平移与缩放）。
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left - rect.width / 2 - panX;
    const py = event.clientY - rect.top - rect.height / 2 - panY;
    panX += px * (1 - next / scale);
    panY += py * (1 - next / scale);
    scale = next;
    fitMode = 'custom';
  }

  function handlePanStart(event: PointerEvent) {
    if (!isImage || event.button !== 0) return;
    panning = true;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panOriginX = panX;
    panOriginY = panY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function handlePanMove(event: PointerEvent) {
    if (!panning) return;
    panX = panOriginX + (event.clientX - panStartX);
    panY = panOriginY + (event.clientY - panStartY);
  }

  function handlePanEnd(event: PointerEvent) {
    if (!panning) return;
    panning = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  function zoomIn() {
    scale = Math.min(ZOOM_MAX, scale + ZOOM_STEP);
    fitMode = 'custom';
  }

  function zoomOut() {
    scale = Math.max(ZOOM_MIN, scale - ZOOM_STEP);
    fitMode = 'custom';
  }
  function rotate() {
    rotation = (rotation + 90) % 360;
  }

  async function saveAs() {
    if (!tab.nativePath) return;
    try {
      await invoke('export_media_file_as', {
        sourcePath: tab.nativePath,
        suggestedName: tab.fileName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'cancelled') {
        logError('MediaViewer', '另存为失败', { error: message });
      }
    }
  }

  function resetView() {
    rotation = 0;
    panX = 0;
    panY = 0;
    applyFit();
  }

  $: if (container && naturalWidth > 0 && fitMode !== 'custom') {
    applyFit();
  }

  $: imageUrl = get(mediaUrl);
</script>

<svelte:window on:resize={() => { if (isImage && fitMode !== 'custom') applyFit(); }} on:message={handleEditorMessage} />

<div class="media-viewer" bind:this={container} data-kind={tab.mediaKind}>
  {#if isImage && imageUrl}
    <div class="media-toolbar">
      <button type="button" on:click={zoomOut} title="缩小">−</button>
      <span class="zoom-value">{Math.round(scale * 100)}%</span>
      <button type="button" on:click={zoomIn} title="放大">+</button>
      <button type="button" on:click={applyFit} class:active={fitMode === 'fit'} title="适配窗口">适配</button>
      <button type="button" on:click={applyActualSize} class:active={fitMode === 'actual'} title="1:1">1:1</button>
      <button type="button" on:click={rotate} title="旋转">↻</button>
      <button type="button" on:click={resetView} title="重置视图">重置</button>
      <span class="toolbar-spacer"></span>
      {#if naturalWidth > 0}
        <span class="dimension">{naturalWidth} × {naturalHeight}</span>
      {/if}
      <button type="button" on:click={saveAs} title="另存为">另存为…</button>
    </div>
    <div
      class="image-stage"
      class:pannable={scale > 1.001}
      class:panning
      on:wheel|nonpassive={handleWheel}
      on:pointerdown={handlePanStart}
      on:pointermove={handlePanMove}
      on:pointerup={handlePanEnd}
      on:pointercancel={handlePanEnd}
      role="presentation"
    >
      <!-- svelte-ignore a11y-misplaced-scope -->
      <img
        src={imageUrl}
        alt={tab.fileName}
        on:load={handleImageLoad}
        style="transform: translate({panX}px, {panY}px) scale({scale}) rotate({rotation}deg);"
        draggable="false"
      />
    </div>
  {:else if isPdf && imageUrl}
    <!-- WebView 自带 PDF 查看能力；只读，不进入编辑/保存流程 -->
    <iframe class="pdf-frame" src={imageUrl} title={tab.fileName}></iframe>
  {:else if isHtml}
    <div class="media-toolbar">
      <span class="html-hint">沙箱预览：无 same-origin，无法访问宿主与文件系统</span>
      <span class="toolbar-spacer"></span>
      <button type="button" on:click={toggleHtmlSource}>
        {htmlSourceMode ? '预览' : '源码'}
      </button>
    </div>
    {#if loadError}
      <div class="media-error">{loadError}</div>
    {:else if htmlSourceMode || htmlSource === null}
      <pre class="html-source">{htmlSource ?? '加载中…'}</pre>
    {:else}
      <!-- 沙箱 iframe：无 same-origin、无 Tauri bridge -->
      <iframe
        class="html-frame"
        title={tab.fileName}
        sandbox="allow-scripts"
        srcdoc={htmlSource}
      ></iframe>
    {/if}
  {:else if isCanvasEditor}
    <div class="media-toolbar">
      <span class="canvas-title">{tab.fileName}</span>
      {#if canvasSaveState === 'error'}
        <span class="canvas-error">{canvasSaveError ?? '保存失败'}</span>
      {:else}
        <span class="canvas-status" class:saving={canvasSaveState === 'saving'}
          class:dirty={canvasSaveState === 'dirty'}>
          {CANVAS_SAVE_STATE_TEXT[canvasSaveState]}
        </span>
      {/if}
      <span class="toolbar-spacer"></span>
      <button
        type="button"
        disabled={!canvasReady || !editorFrame}
        title="立即保存"
        on:click={() => {
          if (isDrawio) editorFrame?.contentWindow?.postMessage({ action: 'export', format: 'xmldrawio', xml: '' }, '*');
          else editorFrame?.contentWindow?.postMessage({ type: 'nomo:flush' }, '*');
        }}
      >保存</button>
    </div>
    {#if canvasSaveState === 'error' && canvasContent === ''}
      <div class="media-error">无法读取画布文件：{canvasSaveError}</div>
    {:else if !drawioEditorUrl && !excalidrawEditorUrl}
      <div class="media-error">编辑器资源缺失，请重新运行 npm run offline-editors:fetch</div>
    {:else}
      {#key tab.nativePath}
        <iframe
          class="canvas-frame"
          title={tab.fileName}
          bind:this={editorFrame}
          src={isDrawio ? drawioEditorUrl : excalidrawEditorUrl}
          allow="clipboard-write"
        ></iframe>
      {/key}
    {/if}
  {:else}
    <div class="media-error">无法打开该文件</div>
  {/if}
</div>

<style>
  .media-viewer {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--md-editor-bg, #fff);
  }

  .media-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--md-editor-border, #e0e0e0);
    font-size: 12px;
    color: var(--md-editor-muted-fg, #888);
    flex-shrink: 0;
  }

  .media-toolbar button {
    border: none;
    background: transparent;
    color: inherit;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  .media-toolbar button:hover {
    background: var(--md-editor-hover-bg, rgba(0, 0, 0, 0.06));
  }

  .media-toolbar button.active {
    background: var(--md-editor-active-bg, rgba(0, 0, 0, 0.1));
  }

  .toolbar-spacer {
    flex: 1;
  }

  .zoom-value,
  .dimension {
    font-variant-numeric: tabular-nums;
    min-width: 44px;
    text-align: center;
  }

  .image-stage {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    min-height: 0;
  }

  .image-stage.pannable {
    cursor: grab;
    touch-action: none;
  }

  .image-stage.panning {
    cursor: grabbing;
  }

  .image-stage img {
    transform-origin: center center;
    max-width: none;
    user-select: none;
  }

  .pdf-frame,
  .html-frame {
    flex: 1;
    width: 100%;
    border: none;
    min-height: 0;
    background: #fff;
  }

  .html-source {
    flex: 1;
    overflow: auto;
    margin: 0;
    padding: 12px 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--md-editor-fg, #222);
  }

  .html-hint {
    opacity: 0.8;
  }

  .canvas-frame {
    flex: 1;
    width: 100%;
    border: none;
    min-height: 0;
    background: #fff;
  }

  .canvas-title {
    font-weight: 600;
    color: var(--md-editor-fg, #333);
  }

  .canvas-status {
    opacity: 0.85;
  }

  .canvas-status.saving,
  .canvas-status.dirty {
    color: var(--md-editor-warning, #b8860b);
  }

  .canvas-error {
    color: var(--md-editor-danger, #c0392b);
  }

  .media-error {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    color: var(--md-editor-muted-fg, #888);
    font-size: 13px;
    text-align: center;
  }
</style>
