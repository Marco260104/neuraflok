import { WINDOWS_HELPER_ACCESSIBILITY } from './helper-accessibility.js';
import { WINDOWS_HELPER_BOOTSTRAP } from './helper-bootstrap.js';
import { WINDOWS_HELPER_REQUESTS } from './windows-helper-requests.js';

export const HELPER_SCRIPT = [WINDOWS_HELPER_BOOTSTRAP, WINDOWS_HELPER_ACCESSIBILITY, WINDOWS_HELPER_REQUESTS].join('');
