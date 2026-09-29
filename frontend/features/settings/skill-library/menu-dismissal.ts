const initializedDocuments = new WeakSet<Document>();

/** Closes open skill menus on outside clicks and Escape. */
export function initSkillMenuDismissal(doc: Document = document): void {
  if (initializedDocuments.has(doc)) return;
  initializedDocuments.add(doc);
  doc.addEventListener('click', event => {
    const target = event.target as Element | null;
    const menu = typeof target?.closest === 'function' ? target.closest('.skill-menu') : null;
    const action = typeof target?.closest === 'function' ? target.closest('.skill-menu-actions') : null;
    for (const open of doc.querySelectorAll<HTMLDetailsElement>('.skill-menu[open]')) {
      if (open !== menu || action) open.open = false;
    }
  });
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    for (const open of doc.querySelectorAll<HTMLDetailsElement>('.skill-menu[open]')) open.open = false;
  });
}
