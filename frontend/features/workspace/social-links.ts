/** Bind the compact community buttons as explicit external links. */
export function bindTopbarSocialLinks(root: ParentNode, openExternal: (url: string) => void): void {
  root.querySelectorAll<HTMLButtonElement>('.app-topbar-social-link').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const url = button.dataset.url;
      if (url) openExternal(url);
    });
  });
}
