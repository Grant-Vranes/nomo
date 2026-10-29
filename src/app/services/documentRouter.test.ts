import { describe, expect, it, vi } from 'vitest';
import { openDocumentByPath } from './documentRouter';

function createPorts() {
  return {
    openMarkdown: vi.fn().mockResolvedValue({ markdown: '# note' }),
    openSegmented: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    openMedia: vi.fn().mockResolvedValue({ opened: true }),
  };
}

describe('openDocumentByPath', () => {
  it.each(['note.md', 'note.markdown'])('opens %s only through the Markdown port', async (path) => {
    const ports = createPorts();

    const result = await openDocumentByPath(path, ports);

    expect(result).toEqual({ documentKind: 'markdown', value: { markdown: '# note' } });
    expect(ports.openMarkdown).toHaveBeenCalledWith(path);
    expect(ports.openSegmented).not.toHaveBeenCalled();
    expect(ports.openMedia).not.toHaveBeenCalled();
  });

  it.each([
    ['large.txt', 'text'],
    ['data.JSON', 'json'],
    ['script.py', 'text'],
  ] as const)('opens %s only through the segmented port', async (path, documentKind) => {
    const ports = createPorts();

    const result = await openDocumentByPath(path, ports);

    expect(result).toEqual({ documentKind, value: { sessionId: 'session-1' } });
    expect(ports.openMarkdown).not.toHaveBeenCalled();
    expect(ports.openMedia).not.toHaveBeenCalled();
    expect(ports.openSegmented).toHaveBeenCalledWith(path, documentKind);
  });

  it.each([
    ['page.html', 'html'],
    ['diagram.drawio', 'drawio'],
    ['sketch.excalidraw', 'excalidraw'],
    ['manual.pdf', 'pdf'],
    ['photo.png', 'image'],
  ] as const)('opens %s only through the media port', async (path, mediaKind) => {
    const ports = createPorts();

    const result = await openDocumentByPath(path, ports);

    expect(result).toEqual({ documentKind: 'media', mediaKind, value: { opened: true } });
    expect(ports.openMarkdown).not.toHaveBeenCalled();
    expect(ports.openSegmented).not.toHaveBeenCalled();
    expect(ports.openMedia).toHaveBeenCalledWith(path, mediaKind);
  });

  it('rejects unsupported files before any storage port runs', async () => {
    const ports = createPorts();

    await expect(openDocumentByPath('table.csv', ports)).rejects.toThrow(/unsupported/i);
    expect(ports.openMarkdown).not.toHaveBeenCalled();
    expect(ports.openSegmented).not.toHaveBeenCalled();
    expect(ports.openMedia).not.toHaveBeenCalled();
  });
});
