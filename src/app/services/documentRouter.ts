import type { DocumentKind, MediaTabState } from '../types';
import { getDocumentKindFromPath, getMediaKindFromPath } from './tabs';

export interface DocumentOpenPorts<MarkdownResult, SegmentedResult, MediaResult> {
  openMarkdown(path: string): Promise<MarkdownResult>;
  openSegmented(path: string, documentKind: 'text' | 'json'): Promise<SegmentedResult>;
  openMedia(path: string, mediaKind: NonNullable<MediaTabState['mediaKind']>): Promise<MediaResult>;
}

export type RoutedDocumentOpenResult<MarkdownResult, SegmentedResult, MediaResult> =
  | { documentKind: 'markdown'; value: MarkdownResult }
  | { documentKind: 'text' | 'json'; value: SegmentedResult }
  | { documentKind: 'media'; mediaKind: NonNullable<MediaTabState['mediaKind']>; value: MediaResult };

/**
 * 文件扩展名是三条存储链路的唯一入口事实源；这里先判型再读取，确保 TXT/JSON
 * 永远没有机会调用会构造完整字符串的 Markdown port，二进制媒体只传路径。
 */
export async function openDocumentByPath<MarkdownResult, SegmentedResult, MediaResult>(
  path: string,
  ports: DocumentOpenPorts<MarkdownResult, SegmentedResult, MediaResult>,
): Promise<RoutedDocumentOpenResult<MarkdownResult, SegmentedResult, MediaResult>> {
  const documentKind: DocumentKind | null = getDocumentKindFromPath(path);
  if (!documentKind) {
    throw new Error(`Unsupported document type: ${path}`);
  }

  if (documentKind === 'markdown') {
    return { documentKind, value: await ports.openMarkdown(path) };
  }

  if (documentKind === 'media') {
    const mediaKind = getMediaKindFromPath(path);
    if (!mediaKind) {
      throw new Error(`Unsupported media type: ${path}`);
    }
    return {
      documentKind,
      mediaKind,
      value: await ports.openMedia(path, mediaKind),
    };
  }

  return {
    documentKind,
    value: await ports.openSegmented(path, documentKind),
  };
}
