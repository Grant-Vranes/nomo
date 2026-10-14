import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineSelectionPaint } from './selectionPaint';

let frames: Map<number, FrameRequestCallback>;
let hitDescriptor: PropertyDescriptor | undefined;
const painters: ReturnType<typeof createLineSelectionPaint>[] = [];
beforeEach(() => {
  frames = new Map();
  hitDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  for (const painter of painters.splice(0)) painter.destroy();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  if (hitDescriptor) Object.defineProperty(document, 'elementFromPoint', hitDescriptor);
  else Reflect.deleteProperty(document, 'elementFromPoint');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function root() {
  const element = document.createElement('div');
  element.innerHTML = '<p style="line-height:24px;font-size:16px;width:400px;background-image:none">正文 code 文本</p>';
  document.body.append(element);
  const painter = createLineSelectionPaint(element);
  painters.push(painter);
  return { element, painter, text: element.firstChild!.firstChild! };
}
function select(text: Node) {
  document.getSelection()!.setBaseAndExtent(text, 0, text, 5);
  document.dispatchEvent(new Event('selectionchange'));
}
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  for (const fn of pending) fn(0);
}
function ruleCount() {
  return [...document.styleSheets].reduce((sum, sheet) => sum + [...sheet.cssRules].reduce((count, rule) =>
    count + ('cssRules' in rule ? (rule as CSSMediaRule).cssRules.length : 1), 0), 0);
}

describe('selection paint ownership and lifetime', () => {
  it('removes row painting and bridge validity immediately when DOM selection collapses', () => {
    const initialRules = ruleCount();
    const { element, text } = root();
    const paragraph = element.firstElementChild!;
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 100));
    vi.spyOn(paragraph, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 24));
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 80, 20)] as unknown as DOMRectList);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => paragraph });
    select(text);
    expect(element.hasAttribute('data-nomo-selection-active')).toBe(true);
    flush();
    expect(ruleCount()).toBeGreaterThan(initialRules);
    document.getSelection()!.collapse(text, 2);
    document.dispatchEvent(new Event('selectionchange'));
    expect(element.hasAttribute('data-nomo-selection-active')).toBe(false);
    expect(ruleCount()).toBe(initialRules);
    expect(frames.size).toBe(0);
  });

  it('paints only the selection owner and relinquishes it to native inputs inside or outside the editor', () => {
    const first = root(), second = root();
    select(first.text);
    expect(first.element.hasAttribute('data-nomo-selection-active')).toBe(true);
    expect(second.element.hasAttribute('data-nomo-selection-active')).toBe(false);
    for (const parent of [first.element, document.body]) {
      const input = document.createElement('textarea');
      parent.append(input);
      input.focus();
      // 原生输入可保留后台正文 Range；此时即使未触发 selectionchange 也不能补色。
      document.getSelection()!.setBaseAndExtent(first.text, 0, first.text, 5);
      document.dispatchEvent(new Event('focusin'));
      expect(first.element.hasAttribute('data-nomo-selection-active')).toBe(false);
      expect(document.getSelection()!.isCollapsed).toBe(false);
      input.remove();
      document.dispatchEvent(new Event('focusin'));
    }
    select(second.text);
    expect(first.element.hasAttribute('data-nomo-selection-active')).toBe(false);
    expect(second.element.hasAttribute('data-nomo-selection-active')).toBe(true);
  });

  it('preserves the range for toolbar operations and window blur, and supports dragging beyond the root', () => {
    const { element, text } = root();
    const toolbar = document.createElement('button');
    toolbar.textContent = '加粗';
    document.body.append(toolbar);
    toolbar.focus();
    select(text);
    window.dispatchEvent(new Event('blur'));
    expect(document.getSelection()!.isCollapsed).toBe(false);
    expect(element.hasAttribute('data-nomo-selection-active')).toBe(true);
    document.getSelection()!.extend(toolbar.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    expect(element.hasAttribute('data-nomo-selection-active')).toBe(true);
  });

  it('releases listeners, pending frames, markers and shared styles through 20 mount/unmount cycles', () => {
    const sheets = document.styleSheets.length;
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    for (let i = 0; i < 20; i++) {
      const { element, painter, text } = root();
      select(text);
      expect(frames.size).toBe(1);
      painter.destroy();
      painter.destroy();
      expect(frames.size).toBe(0);
      expect(element.hasAttribute('data-nomo-selection-root')).toBe(false);
      expect(element.hasAttribute('data-nomo-selection-active')).toBe(false);
      element.remove();
      expect(document.styleSheets.length).toBe(sheets);
    }
    for (const [name, listener] of added.mock.calls) {
      if (['selectionchange', 'focusin', 'focusout'].includes(name))
        expect(removed).toHaveBeenCalledWith(name, listener);
    }
  });
});
