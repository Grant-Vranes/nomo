import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { renderHtmlPreview, sanitizeHtml } from '../utils/html';
import { isInlineSourceText } from '../InlineSourceCodec';

const tableHtmlKey = new PluginKey('tableHtml');

export function tableHtmlBlockPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tableHtmlKey,
    state: {
      init(_, state) {
        return buildTableHtmlDecorations(state.doc);
      },
      apply(tr, oldSet, _oldState, newState) {
        if (!tr.docChanged) return oldSet;
        return buildTableHtmlDecorations(newState.doc, oldSet.map(tr.mapping, newState.doc));
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

function buildTableHtmlDecorations(
  doc: ProseMirrorNode,
  previousSet: DecorationSet = DecorationSet.empty,
): DecorationSet {
  const decorations: Decoration[] = [];
  const previousWidgets = new Map<number, Decoration>();
  for (const decoration of previousSet.find()) {
    if (decoration.spec.htmlNode) previousWidgets.set(decoration.from, decoration);
  }

  doc.forEach((node, pos) => {
    let widget = previousWidgets.get(pos);
    // 复用映射后的 widget，避免普通正文输入替换未变化的 HTML 和图片 DOM。
    if (!widget || !widget.spec.htmlNode.eq(node)) {
      const htmlResult = tryParseHtmlBlock({ node, pos });
      if (!htmlResult) return;
      const { safeHtml } = htmlResult;
      widget = Decoration.widget(pos, () => {
        // EditorState 可以跨挂载保留；构造函数只捕获 HTML，不持有旧视图的 DOM。
        const preview = document.createElement('span');
        preview.className = 'html-widget';
        preview.setAttribute('contenteditable', 'false');
        renderHtmlPreview(preview, safeHtml);
        return preview;
      }, { side: 0, htmlNode: node });
    }
    decorations.push(
      widget,
      Decoration.inline(
        pos + 1,
        pos + node.nodeSize - 1,
        { style: 'display: none' },
        { inclusiveStart: false, inclusiveEnd: false },
      ),
    );
  });
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function tryParseHtmlBlock(block: {
  node: ProseMirrorNode;
  pos: number;
}): { pos: number; node: ProseMirrorNode; safeHtml: string } | null {
  // 代码块和 html_block 已有各自的渲染职责，不能再生成 HTML widget
  if (block.node.type.spec.code || block.node.type.name === 'html_block') return null;
  // 六类内联 HTML 定界符由原文编辑插件处理，不能再次整段替换成不可编辑 widget。
  if (/^\s*<\/?(?:strong|b|em|i|code|s|del|strike|u|mark)(?:\s|>)/i.test(block.node.textContent) &&
      Array.from({ length: block.node.childCount }, (_, i) => block.node.child(i)).some(isInlineSourceText)) return null;
  const text = block.node.textContent.trim();
  if (!/^<(\w+)[^>]*>/.test(text)) return null;
  const safeHtml = sanitizeHtml(text);
  if (!safeHtml) return null;
  return { pos: block.pos, node: block.node, safeHtml };
}
