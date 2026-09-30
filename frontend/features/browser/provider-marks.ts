import { isWebProviderId, type WebProviderId } from '../../../contracts/web-providers.js';
import deepseekLogo from '../../../brand/deepseek.svg?url';
import kimiLogo from '../../../brand/kimi.svg?url';
import kimiDarkLogo from '../../../brand/kimi_dark.svg?url';
import qwenLogo from '../../../brand/qwen.svg?url';
import glmLogo from '../../../brand/glm_zai.svg?url';
import glmDarkLogo from '../../../brand/glm_zai_dark.svg?url';

const marks: Record<WebProviderId, { light: string; dark?: string }> = {
  deepseek: { light: deepseekLogo },
  kimi: {
    light: kimiLogo,
    dark: kimiDarkLogo
  },
  qwen: { light: qwenLogo },
  glm: {
    light: glmLogo,
    dark: glmDarkLogo
  }
};

/** Decorative marks accompany the provider name; theme variants follow CSS immediately. */
export function providerMark(provider: WebProviderId): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = 'provider-logo';
  mark.setAttribute('aria-hidden', 'true');
  const sources = marks[provider];
  for (const [theme, src] of Object.entries(sources)) {
    const image = document.createElement('img');
    image.src = src;
    image.alt = '';
    image.width = image.height = 28;
    image.draggable = false;
    if (sources.dark) image.className = `provider-logo-${theme}`;
    mark.append(image);
  }
  return mark;
}

export function mountProviderMarks(): void {
  for (const host of document.querySelectorAll<HTMLElement>('[data-provider-logo]')) {
    const provider = host.dataset.providerLogo;
    if (isWebProviderId(provider)) host.replaceChildren(providerMark(provider));
  }
}
