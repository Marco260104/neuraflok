/**
 * DeepSeek handles file-input changes in the page's main JavaScript world.
 * Files created by an isolated extension world can be rejected by that input
 * in current Chromium builds, even though the same file works in DeepSeek's
 * native picker. Keep this function self-contained because Chrome serializes
 * it into the provider page.
 */
export function stageDeepseekFilesInMainWorld(rows) {
  try {
    if (!Array.isArray(rows) || !rows.length || typeof document === 'undefined' ||
        typeof DataTransfer !== 'function' || typeof File !== 'function') return { ok: false };

    const roots = [document];
    const visited = new Set();
    let inspected = 0;
    for (let index = 0; index < roots.length && index < 32 && inspected < 5_000; index += 1) {
      const root = roots[index];
      if (!root || visited.has(root)) continue;
      visited.add(root);
      for (const host of root.querySelectorAll('*')) {
        inspected += 1;
        if (host?.shadowRoot && !visited.has(host.shadowRoot)) roots.push(host.shadowRoot);
        if (inspected >= 5_000) break;
      }
    }

    const inputs = roots.flatMap(root => Array.from(root.querySelectorAll('input[type="file"]')))
      .filter(input => input.disabled !== true && input.getAttribute('aria-disabled') !== 'true');
    const accepts = (input, row) => {
      const accept = String(input.getAttribute('accept') || '').toLowerCase();
      if (!accept) return true;
      const tokens = accept.split(',').map(value => value.trim()).filter(Boolean);
      const extension = String(row.name || '').match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
      return tokens.some(token => token === row.mimeType.toLowerCase() || token === '*/*' ||
        (row.mimeType.startsWith('image/') && token === 'image/*') ||
        (extension && token === extension));
    };
    const input = inputs.find(candidate => rows.every(row => accepts(candidate, row)));
    if (!input) return { ok: false };

    const transfer = new DataTransfer();
    const selected = Array.from(input.files || []);
    const keys = new Set();
    const addOnce = file => {
      const key = `${file.name}\0${file.type}\0${file.size}`;
      if (keys.has(key)) return;
      keys.add(key);
      transfer.items.add(file);
    };
    for (const file of selected) addOnce(file);
    for (const row of rows) {
      if (!row || typeof row.name !== 'string' || typeof row.mimeType !== 'string' ||
          !Array.isArray(row.chunks) || !row.chunks.every(chunk => typeof chunk === 'string')) return { ok: false };
      const alreadySelected = selected.some(file => file.name === row.name && file.type === row.mimeType &&
        (typeof row.size !== 'number' || file.size === row.size));
      if (alreadySelected) continue;
      const parts = row.chunks.map(chunk => {
        const binary = atob(chunk);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      });
      addOnce(new File(parts, row.name, { type: row.mimeType }));
    }

    input.files = transfer.files;
    // DeepSeek's change handler consumes the FileList and may clear the
    // controlled input synchronously. Verify the assignment before dispatching
    // the event; checking after dispatch mistakes a successful upload for a
    // failed injection and causes the retry path to upload the same image again.
    const staged = Array.from(input.files || []);
    const stagedAllRows = rows.every(row => staged.some(file => file.name === row.name && file.type === row.mimeType &&
      (typeof row.size !== 'number' || file.size === row.size)));
    if (!stagedAllRows) return { ok: false };
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function stageDeepseekAttachmentsInMainWorld(chrome, tabId, rows) {
  if (!Number.isInteger(tabId) || !Array.isArray(rows) || !rows.length ||
      typeof chrome?.scripting?.executeScript !== 'function') return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: stageDeepseekFilesInMainWorld,
      args: [rows]
    });
    return Array.isArray(results) && results.some(result => result?.result?.ok === true);
  } catch {
    return false;
  }
}
