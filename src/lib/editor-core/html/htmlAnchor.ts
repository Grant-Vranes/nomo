import { createLinkAttrs } from '../link';
import { escapeHtmlAttr } from '../markdownTokenizer';

export interface HtmlAnchorAttrs extends Record<string, unknown> {
  href: string | null;
  title: string | null;
  id: string | null;
  name: string | null;
  html: true;
}

/** HTML 锚点允许没有 href，但有地址时仍使用普通链接的协议校验。 */
export function createHtmlAnchorAttrs(
  href: string | null,
  title: string | null,
  id: string | null,
  name: string | null,
): HtmlAnchorAttrs | null {
  const link = href === null ? null : createLinkAttrs(href, title);
  if (href !== null && !link) return null;
  return { href: link?.href ?? null, title: link?.title ?? title, id, name, html: true };
}

export function serializeHtmlAnchorOpen(attrs: Record<string, unknown>): string {
  const parts: string[] = [];
  const link = createLinkAttrs(attrs.href, attrs.title);
  if (link) parts.push(`href="${escapeHtmlAttr(link.href)}"`);
  for (const key of ['title', 'id', 'name']) {
    if (attrs[key] != null) parts.push(`${key}="${escapeHtmlAttr(String(attrs[key]))}"`);
  }
  return `<a${parts.length ? ` ${parts.join(' ')}` : ''}>`;
}
