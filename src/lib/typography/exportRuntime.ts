import { createDomTypography, waitForTypographyAssets } from './dom';
import { DEFAULT_TYPOGRAPHY, type TypographyOptions } from './types';
import { createExportTableLayout } from '../table-layout/export';

declare global {
  interface Window {
    __NOMO_FLUSH_TYPOGRAPHY__?: () => Promise<void>;
    __NOMO_PREPARE_PRINT__?: (widthMm: number) => Promise<void>;
  }
}

const root = document.querySelector<HTMLElement>('.nomo-export');
if (root) {
  const options: TypographyOptions = {
    ...DEFAULT_TYPOGRAPHY,
    ...JSON.parse(document.getElementById('nomo-typography-options')?.textContent ?? '{}'),
  };
  const controller = createDomTypography(root, options);
  const tables = createExportTableLayout(root);
  let printing = false;
  window.__NOMO_FLUSH_TYPOGRAPHY__ = async () => {
    await waitForTypographyAssets(root);
    await tables.flush(printing);
    controller.invalidate();
    await controller.flush();
  };
  window.__NOMO_PREPARE_PRINT__ = async (widthMm) => {
    if (!Number.isFinite(widthMm) || widthMm <= 0) throw new Error('Invalid print width');
    root.style.setProperty('width', `${widthMm}mm`, 'important');
    root.style.setProperty('max-width', 'none', 'important');
    root.style.setProperty('padding', '0', 'important');
    root.style.setProperty('margin', '0', 'important');
    printing = true;
    await window.__NOMO_FLUSH_TYPOGRAPHY__!();
  };
  window.addEventListener('pagehide', () => { tables.destroy(); controller.destroy(); }, { once: true });
  void window.__NOMO_FLUSH_TYPOGRAPHY__().catch(() => {
    root.dataset.kpState = 'error';
  });
}
