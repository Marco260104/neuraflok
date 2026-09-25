import { WINDOWS_ACTION_BATCH } from './windows-action-batch.js';
import { WINDOWS_APPS_SCRIPT } from './windows-app-catalog.js';
import { WINDOWS_CAPTURE_REQUESTS } from './windows-capture-requests.js';
import { WINDOWS_REQUEST_CHANNEL } from './windows-request-channel.js';
import { WINDOWS_REQUEST_ROUTER } from './windows-request-router.js';

export const WINDOWS_HELPER_REQUESTS = [
  WINDOWS_CAPTURE_REQUESTS,
  WINDOWS_APPS_SCRIPT,
  WINDOWS_ACTION_BATCH,
  WINDOWS_REQUEST_ROUTER,
  WINDOWS_REQUEST_CHANNEL
].join('\n\n');
