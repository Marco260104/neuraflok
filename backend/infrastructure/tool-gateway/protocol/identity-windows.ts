import { evidenceWindow } from '../../../domains/sessions/history/recorder.js';

export const PRIME_EVIDENCE_MS = evidenceWindow(2_500);
export const IDENTITY_EVIDENCE_MS = evidenceWindow(15_000);
export const UNATTRIBUTED_DESKTOP_EVIDENCE_MS = evidenceWindow(250);
export const SPAWN_EVIDENCE_MS = evidenceWindow(30_000);
