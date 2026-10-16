import type { IntegratedBrowserToolbarApi } from '../../../../contracts/browser/integrated-browser-toolbar.js';
import { mountIntegratedBrowserToolbar } from './controller.js';

const api = (window as unknown as Window & { integratedBrowser: IntegratedBrowserToolbarApi }).integratedBrowser;
mountIntegratedBrowserToolbar(document, api);
