/** Shows the current version's release highlights once when translations are available. */
import { releaseNotesUrl, whatsNewAction } from '../../../contracts/whats-new.js';
import { $, el, icon, run } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

interface Highlight { icon: string; title: () => string; text: () => string }
interface Release { lead: () => string; highlights: Highlight[] }

const RELEASES: Readonly<Record<string, Release>> = {
  '0.1.0': {
    lead: () => t('NEURAFLOK brings DeepSeek, Kimi, Qwen, and Z AI browser sessions into one local workspace.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t('Four browser providers'), text: () => t('Use signed-in DeepSeek, Kimi, Qwen, and Z AI sessions from one desktop workspace.') },
      { icon: 'i-globe', title: () => t('An integrated browser'), text: () => t('Sign in to a provider in NEURAFLOK. The app connects its companion automatically.') },
      { icon: 'i-folder', title: () => t('Local project tools'), text: () => t('Work with approved project files, search, and a workspace terminal.') },
      { icon: 'i-plug', title: () => t('Optional API conversations'), text: () => t('Configure an API endpoint and model when you want an API-based conversation.') },
      { icon: 'i-lock', title: () => t('Your permissions stay explicit'), text: () => t('Choose approved folders and capabilities before local tools can use them.') }
    ]
  }
};

export function hasHighlights(version: string): boolean {
  return Object.hasOwn(RELEASES, version);
}

/** Paints the dialog for one version; separate from showing it so a check can paint any entry. */
export function paintWhatsNew(version: string): boolean {
  const release = RELEASES[version];
  if (!release) return false;
  ui($('whatsNewVersion'), 'textContent', () => t('Version {0}', [version]));
  ui($('whatsNewLead'), 'textContent', release.lead);
  $('whatsNewList').replaceChildren(...release.highlights.map((item, index) => {
    const row = el('li', 'whats-new-item');
    // The rows arrive one after another, after the card and its tile.
    row.style.setProperty('--i', String(index));
    const badge = el('span', 'whats-new-icon');
    badge.append(icon(item.icon));
    const words = el('div', 'whats-new-words');
    words.append(el('b', '', item.title), el('span', '', item.text));
    row.append(badge, words);
    return row;
  }));
  const notes = $<HTMLButtonElement>('whatsNewNotes');
  notes.hidden = !releaseNotesUrl(version);
  notes.dataset.version = version;
  return true;
}

/** Centred in a window of odd width or height, the dialog starts half a pixel off the pixel grid and every icon in it blurs and drifts by that half pixel. Its own size is whole pixels, so whole-pixel margins keep it centred within half a pixel and crisp. Margins, not a transform: a fractional transform rasterises the glyphs off the grid all the same. */
function snapToPixels(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  const x = (window.innerWidth - dialog.offsetWidth) / 2;
  const y = (window.innerHeight - dialog.offsetHeight) / 2;
  dialog.style.margin = x < 0 || y < 0 ? '' : `${Math.floor(y)}px ${Math.ceil(x)}px ${Math.ceil(y)}px ${Math.floor(x)}px`;
}

let wired = false;
function wire(dialog: HTMLDialogElement): void {
  if (wired) return;
  wired = true;
  window.addEventListener('resize', () => snapToPixels(dialog));
  const close = (): void => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const done = (): void => { dialog.classList.remove('is-closing'); if (dialog.open) dialog.close(); };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else { dialog.addEventListener('animationend', done, { once: true }); window.setTimeout(done, 280); }
  };
  $('whatsNewDone').addEventListener('click', close);
  $('whatsNewNotes').addEventListener('click', () => {
    const version = $<HTMLButtonElement>('whatsNewNotes').dataset.version;
    const url = version ? releaseNotesUrl(version) : null;
    if (url) void run(window.api.openLink(url, { external: true }));
  });
  // Escape and a click on the backdrop dismiss it like the button does, with the same motion.
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
}

/** Decides once per start: shows the dialog after a real update to a version with highlights and records the version once it has been shown, so it never shows twice; any other version change is recorded at once. A fresh install has already recorded its version in the main process, before anything here runs. */
export function initWhatsNew(current: string | null, lastSeen: string | undefined): void {
  if (!current) return;
  const action = whatsNewAction(current, lastSeen, hasHighlights);
  if (action === 'none') return;
  if (action !== 'show' || !paintWhatsNew(current)) { void run(window.api.markWhatsNewSeen()); return; }
  const dialog = $<HTMLDialogElement>('whatsNewDialog');
  wire(dialog);
  // After the window has painted its first state, so the dialog opens over a settled app. Another open dialog wins; the version is recorded only once this one has really been shown.
  window.setTimeout(() => {
    if (dialog.open || document.querySelector('dialog[open]')) return;
    dialog.showModal();
    snapToPixels(dialog);
    // Enter answers it at once; the focus ring appears only once the keyboard is used.
    $('whatsNewDone').focus({ focusVisible: false } as FocusOptions);
    void run(window.api.markWhatsNewSeen());
  }, 600);
}
