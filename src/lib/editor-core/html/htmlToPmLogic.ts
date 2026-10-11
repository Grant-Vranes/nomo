import type { Schema } from 'prosemirror-model';
import { INLINE_TAG_TO_MARK } from './htmlPolicy';
import { createHtmlAnchorAttrs } from './htmlAnchor';

/**
 * 在 MarkdownParseState 上下文中遍历 DOM 片段，调用 openMark/addText/closeMark。
 * 此函数在 parser handler 内部使用，不直接创建 ProseMirror Node。
 */
export function parseHtmlContent(
  state: {
    openMark(mark: unknown): void;
    closeMark(markType: unknown): void;
    addText(text: string): void;
    openNode(type: unknown, attrs?: Record<string, unknown>): void;
    closeNode(): void;
  },
  innerHTML: string,
  schema: Schema,
): void {
  const template = document.createElement('template');
  template.innerHTML = innerHTML;
  walkDOMFragment(state, template.content, schema);
}

function walkDOMFragment(
  state: {
    openMark(mark: unknown): void;
    closeMark(markType: unknown): void;
    addText(text: string): void;
    openNode(type: unknown, attrs?: Record<string, unknown>): void;
    closeNode(): void;
  },
  parent: Node,
  schema: Schema,
): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      state.addText(child.textContent ?? '');
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const markName = INLINE_TAG_TO_MARK[tag];

      if (tag === 'a' && !el.childNodes.length) {
        const attrs = createHtmlAnchorAttrs(
          el.getAttribute('href'),
          el.getAttribute('title'),
          el.getAttribute('id'),
          el.getAttribute('name'),
        );
        if (attrs) {
          state.openNode(schema.nodes.html_anchor, attrs);
          state.closeNode();
        }
        continue;
      }

      if (markName) {
        const markType = (
          schema.marks as Record<
            string,
            { create(attrs?: Record<string, unknown> | null): unknown }
          >
        )[markName];
        if (markType) {
          let attrs: Record<string, unknown> | null = null;
          if (markName === 'link') {
            const linkAttrs = createHtmlAnchorAttrs(
              el.getAttribute('href'),
              el.getAttribute('title'),
              el.getAttribute('id'),
              el.getAttribute('name'),
            );
            attrs = linkAttrs ? { ...linkAttrs } : null;
            if (!attrs) {
              walkDOMFragment(state, el, schema);
              continue;
            }
          }
          const mark = markType.create(attrs);
          state.openMark(mark);
          walkDOMFragment(state, el, schema);
          state.closeMark(markType);
          continue;
        }
      }

      if (tag === 'br') {
        state.addText('\n');
      } else {
        // 未知内联元素（如 span）— 递归处理子节点
        walkDOMFragment(state, el, schema);
      }
    }
  }
}
