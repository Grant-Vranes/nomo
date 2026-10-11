import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { schema } from '../schema';
import { readTaskListMarker } from '../InlineSourceCodec';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

const taskListPluginKey = new PluginKey('taskList');

type TaskMarkerRange = { from: number; to: number; checked: boolean };

export function taskListPlugin(): Plugin {
  return new Plugin({
    key: taskListPluginKey,
    state: {
      init(_, state) {
        return buildTaskDecorations(state.doc);
      },
      apply(tr, oldSet, _oldState, newState) {
        if (!tr.docChanged) return oldSet;
        return buildTaskDecorations(newState.doc);
      },
    },
    view(view) {
      let editable = view.editable;
      return {
        update() {
          if (editable === view.editable) return;
          editable = view.editable;
          for (const input of view.dom.querySelectorAll<HTMLInputElement>('.task-checkbox-widget input')) {
            input.disabled = !editable;
          }
        },
      };
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
      handleDOMEvents: {
        mousedown(view, event) {
          const widget = findTaskWidget(event);
          if (!widget) return false;
          event.preventDefault();
          event.stopPropagation();
          const marker = readCurrentTaskMarker(view, widget);
          if (!marker) return true;
          if (!view.editable) {
            restoreCheckbox(widget, marker.checked);
            return true;
          }
          setTaskChecked(view, marker, !marker.checked);
          return true;
        },
        click(view, event) {
          const widget = findTaskWidget(event);
          if (!widget) return false;
          // mousedown 已提交；阻止浏览器再次切换原生 checkbox。
          event.preventDefault();
          event.stopPropagation();
          return true;
        },
        change(view, event) {
          const widget = findTaskWidget(event);
          if (!widget) return false;
          event.preventDefault();
          event.stopPropagation();
          const marker = readCurrentTaskMarker(view, widget);
          const input = widget.querySelector<HTMLInputElement>('input');
          if (!marker || !input) return true;
          if (!view.editable) {
            restoreCheckbox(widget, marker.checked);
            return true;
          }
          setTaskChecked(view, marker, input.checked);
          return true;
        },
      },
    },
  });
}

function findTaskWidget(event: Event): HTMLElement | null {
  return event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-task-from]')
    : null;
}

function readCurrentTaskMarker(view: EditorView, widget: HTMLElement): TaskMarkerRange | null {
  if (!view.dom.contains(widget)) return null;
  const from = Number(widget.dataset.taskFrom);
  const to = Number(widget.dataset.taskTo);
  if (!Number.isInteger(from) || to !== from + 3 || from < 0 || to > view.state.doc.content.size) {
    return null;
  }
  const $from = view.state.doc.resolve(from);
  if (
    $from.depth < 2 || $from.parentOffset !== 0 ||
    $from.node($from.depth - 1).type !== schema.nodes.list_item ||
    $from.index($from.depth - 1) !== 0
  ) return null;
  const marker = readTaskListMarker($from.parent);
  return marker ? { from, to, checked: marker.checked } : null;
}

function setTaskChecked(view: EditorView, marker: TaskMarkerRange, checked: boolean): void {
  // 提交时再次读取 editable，避免控件事件跨越运行时只读切换。
  if (!view.editable || marker.checked === checked) return;
  const firstText = view.state.doc.nodeAt(marker.from);
  view.dispatch(
    view.state.tr.replaceWith(marker.from, marker.to, schema.text(checked ? '[x]' : '[ ]', firstText?.marks)),
  );
}

function restoreCheckbox(widget: HTMLElement, checked: boolean): void {
  const input = widget.querySelector<HTMLInputElement>('input');
  if (input) input.checked = checked;
}

function buildTaskDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.list_item) return true;
    const paragraph = node.firstChild;
    const marker = paragraph ? readTaskListMarker(paragraph) : null;
    if (!marker) return true;
    // 仅装饰当前 item 的直接首段；继续遍历以保留真正的嵌套任务项。
    const bracketStart = pos + 2;
    const bracketEnd = bracketStart + 3;
    decorations.push(Decoration.widget(bracketStart, (view) =>
      createTaskCheckboxWidget(marker.checked, bracketStart, bracketEnd, view),
    ));
    decorations.push(
      Decoration.inline(
        bracketStart,
        bracketEnd,
        { style: 'display: none;' },
        { inclusiveStart: false, inclusiveEnd: false },
      ),
    );
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

function createTaskCheckboxWidget(
  checked: boolean,
  from: number,
  to: number,
  view: EditorView,
): HTMLElement {
  const span = document.createElement('span');
  span.className = 'task-checkbox-widget';
  span.setAttribute('contenteditable', 'false');
  span.dataset.taskFrom = String(from);
  span.dataset.taskTo = String(to);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = !view.editable;
  input.setAttribute('tabindex', '-1');
  span.appendChild(input);
  return span;
}
