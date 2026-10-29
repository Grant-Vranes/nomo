/**
 * 桌面端文件类型路由：`docs/desktop-file-support.md` 中表格的前端事实源。
 * Rust 侧镜像实现见 `src-tauri/src/file_types.rs`，两侧新增类型必须同步修改。
 */

export type DesktopFileKind =
  | 'markdown'
  | 'code'
  | 'html'
  | 'drawio'
  | 'excalidraw'
  | 'pdf'
  | 'image';

const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx'];

const CODE_EXTENSIONS = [
  'py', 'pyw', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'json5',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'rs', 'go', 'rb', 'php', 'java', 'kt', 'kts',
  'swift', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'm', 'mm', 'dart', 'lua', 'pl',
  'pm', 'r', 'jl', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'xml',
  'css', 'scss', 'sass', 'less', 'styl', 'vue', 'svelte', 'astro', 'graphql', 'gql', 'proto',
  'zig', 'nim', 'v', 'ex', 'exs', 'erl', 'hrl', 'hs', 'elm', 'clj', 'cljs', 'scala', 'groovy',
  'gradle', 'cmake', 'dockerfile', 'makefile', 'lock', 'gitignore', 'editorconfig', 'txt',
];

const HTML_EXTENSIONS = ['html', 'htm'];
const DRAWIO_EXTENSIONS = ['drawio'];
const EXCALIDRAW_EXTENSIONS = ['excalidraw'];
const PDF_EXTENSIONS = ['pdf'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];

/** 常见无后缀名按文件名识别（小写、不含开头的点）。 */
const CODE_FILE_NAMES = [
  'dockerfile', 'makefile', 'cmakelists.txt', 'license', 'licence', 'notice', 'authors',
  'contributors', 'changelog', 'rust-toolchain', 'gitattributes', 'gitmodules', 'npmrc',
  'nvmrc', 'babelrc', 'eslintrc', 'prettierrc',
];

function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function fileNameLower(path: string): string {
  return (path.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
}

/** 按文件名判定代码/文本：常见无后缀名、`.gitignore`/`.env*` 等点文件、其余无后缀回退。 */
export function isCodeLikeFileName(path: string): boolean {
  const name = fileNameLower(path);
  if (!name) return false;
  if (name.startsWith('.') && name.length > 1) return true;
  if (CODE_FILE_NAMES.includes(name)) return true;
  return extensionOf(path) === '';
}

export function classifyDesktopFile(path: string): DesktopFileKind | null {
  const name = fileNameLower(path);
  if (!name) return null;
  const extension = extensionOf(path);
  if (extension) {
    if (MARKDOWN_EXTENSIONS.includes(extension)) return 'markdown';
    if (HTML_EXTENSIONS.includes(extension)) return 'html';
    if (DRAWIO_EXTENSIONS.includes(extension)) return 'drawio';
    if (EXCALIDRAW_EXTENSIONS.includes(extension)) return 'excalidraw';
    if (PDF_EXTENSIONS.includes(extension)) return 'pdf';
    if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
    if (CODE_EXTENSIONS.includes(extension)) return 'code';
  }
  if (isCodeLikeFileName(path)) return 'code';
  return null;
}

export function isSupportedDesktopFile(path: string): boolean {
  return classifyDesktopFile(path) !== null;
}

export interface OpenedFilesPorts<MarkdownResult, TextResult, MediaResult> {
  openMarkdown(path: string): Promise<MarkdownResult>;
  openCode(path: string): Promise<TextResult>;
  openMedia(path: string, kind: 'html' | 'drawio' | 'excalidraw' | 'pdf' | 'image'): Promise<MediaResult>;
}

export type DispatchedOpenResult<MarkdownResult, TextResult, MediaResult> =
  | { kind: 'markdown'; value: MarkdownResult }
  | { kind: 'code'; value: TextResult }
  | { kind: 'media'; mediaKind: 'html' | 'drawio' | 'excalidraw' | 'pdf' | 'image'; value: MediaResult }
  | { kind: 'skipped'; reason: 'duplicate' | 'unsupported' };

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * 打开入口的统一分流：重复路径只开一个 tab，单项失败不阻断后续文件。
 * 调用方持有已打开路径集合（跨窗口由 Rust 端 open-targets 注册表兜底）。
 */
export async function dispatchOpenedFiles<MarkdownResult, TextResult, MediaResult>(
  paths: readonly string[],
  ports: OpenedFilesPorts<MarkdownResult, TextResult, MediaResult>,
  options: { openedPaths?: Set<string> } = {},
): Promise<Array<{ path: string; error: string }>> {
  const opened = options.openedPaths ?? new Set<string>();
  const failures: Array<{ path: string; error: string }> = [];
  const seenInBatch = new Set<string>();
  for (const path of paths) {
    const key = normalizePathKey(path);
    if (seenInBatch.has(key) || opened.has(key)) continue;
    seenInBatch.add(key);
    const kind = classifyDesktopFile(path);
    if (!kind) {
      failures.push({ path, error: `Unsupported file type: ${path}` });
      continue;
    }
    try {
      if (kind === 'markdown') {
        await ports.openMarkdown(path);
      } else if (kind === 'code') {
        await ports.openCode(path);
      } else {
        await ports.openMedia(path, kind);
      }
      opened.add(key);
    } catch (error) {
      failures.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}
