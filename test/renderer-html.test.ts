import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
let dom: JSDOM;
let renderedMessage: (html: string | null | undefined, fallback: string) => HTMLElement;
let renderedMarkdown: (text: string) => HTMLElement;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/' });
  Object.defineProperty(dom.window, 'api', { value: {}, configurable: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node
  });
  ({ renderedMessage, renderedMarkdown } = await import('../frontend/features/chat/chat.js'));
});

afterAll(() => {
  dom.window.close();
});

describe('provider Markdown rendering', () => {
  it('renders a short greeting as a clean, complete paragraph', () => {
    const rendered = renderedMarkdown('Hola.');
    expect(rendered.classList.contains('rich')).toBe(true);
    expect(rendered.querySelectorAll(':scope > p')).toHaveLength(1);
    expect(rendered.querySelector(':scope > p')?.textContent).toBe('Hola.');
  });

  it('preserves ordinary Markdown structure and surrounding prose', () => {
    const answer = '## Examples from sample data\n\n' +
      '✅ **Strong matching candidate**\n\nCSV: `Sample product 20mg 30 tablets`\n\n' +
      'Existing: `SAMPLE PRODUCT 20MG 30 TABLETS`\n\n98% name similarity.\n\n---\n\n' +
      '⚠️ **Must not merge automatically**\n\nCSV: `Example product 70mg 60 tablets`\n\n' +
      'Existing: `EXAMPLE PRODUCT 50MG 60 TABLETS`\n\nStrength differs.';
    const rendered = renderedMarkdown(answer);
    expect(rendered.querySelector('h2')?.textContent).toBe('Examples from sample data');
    expect(rendered.querySelectorAll('strong')).toHaveLength(2);
    expect(rendered.querySelectorAll('code')).toHaveLength(4);
    expect(rendered.querySelector('hr')).not.toBeNull();
    expect(rendered.textContent).toContain('⚠️ Must not merge automatically');
  });

  it('removes unsupported marker lines while preserving surrounding text', () => {
    const pointer = '::provider-reference{index="0" source_message_id="message-1"}';
    const rendered = renderedMarkdown('Before\n' + pointer + '\nAfter');
    expect(rendered.textContent).toContain('Before');
    expect(rendered.textContent).toContain('After');
    expect(rendered.textContent).not.toContain('provider-reference');
  });

  it('renders provider writing blocks as safe titled quotes', () => {
    const rendered = renderedMarkdown(':::writing{variant="standard" id="58321" title="Clear <rewrite>"}\nWe want the app to be **faster**.\n:::\n\nAfter the block.');
    const quote = rendered.querySelector('blockquote')!;
    expect(quote.querySelector('strong')?.textContent).toBe('Clear <rewrite>');
    expect(quote.textContent).toContain('We want the app to be faster.');
    expect(rendered.textContent).not.toContain(':::');
    expect(rendered.textContent).toContain('After the block.');
  });

  it('opens safe Markdown links on nested text clicks and middle clicks', () => {
    const openLink = vi.fn(async () => ({ ok: true, data: true }));
    (dom.window as any).api.openLink = openLink;
    const rendered = renderedMarkdown('[**Project**](https://example.com/project)');
    rendered.querySelector('strong')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    rendered.querySelector('a')!.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    expect(openLink.mock.calls).toEqual([['https://example.com/project'], ['https://example.com/project']]);
  });

  it('keeps Markdown tables readable without trusting authored styles', () => {
    for (const rendered of [
      renderedMarkdown('| Area | Details |\n| --- | --- |\n| Great Hall | ' + 'Longunbrokenfilename'.repeat(20) + ' |'),
      renderedMessage('<table style="width:9999px"><tr><td colspan="2" style="white-space:nowrap">All details remain readable</td></tr></table>', '')
    ]) {
      const table = rendered.querySelector('table')!;
      expect(table.parentElement?.className).toBe('markdown-table');
      expect(table.parentElement?.tabIndex).toBe(0);
      expect(table.querySelector('td')?.textContent).toBeTruthy();
      expect(table.querySelector('[style]')).toBeNull();
      expect(table.getAttribute('style')).toBeNull();
    }
  });

  it('renders canonical Markdown and strips executable content', () => {
    const rendered = renderedMarkdown('1. Rain begins when **water condenses**.\n\n2. The final paragraph. NEURAFLOK-0606-FINAL-A\n\n```js\nconst rain = true;\n```\n<script>alert(1)</script>');
    expect(rendered.querySelectorAll('li')).toHaveLength(2);
    expect(rendered.querySelector('strong')?.textContent).toBe('water condenses');
    expect(rendered.querySelector('pre code')?.textContent).toContain('const rain = true;');
    expect(rendered.textContent).toContain('NEURAFLOK-0606-FINAL-A');
    expect(rendered.querySelector('script')).toBeNull();
  });

  it('keeps every example in a long code answer and decodes Markdown entities', () => {
    const snippets = [
      '#include <vector>\nint main() { std::vector<int> values{3, 1}; }',
      '#include <map>\nint main() { std::map<int, int> values; }',
      '#include <set>\nint main() { std::set<int> values; }',
      '#include <algorithm>\nint main() { std::sort(values.begin(), values.end()); }',
      '#include <numeric>\nint main() { std::accumulate(values.begin(), values.end(), 0); }',
      '#include <numeric>\nint main() {\n  std::cout << "complete";\n  return 0;\n}'
    ];
    const answer = '**1.&#x20;** `std::vector` examples\n\n' + snippets.map(code => `\`\`\`cpp\n${code}\n\`\`\``).join('\n\n');
    const rendered = renderedMarkdown(answer);

    expect(rendered.querySelectorAll('.markdown-code')).toHaveLength(6);
    expect(rendered.querySelector('strong')?.textContent).toBe('1. ');
    expect(rendered.textContent).not.toContain('&#x20;');
    expect(rendered.querySelectorAll('.markdown-code pre code').item(5)?.textContent?.trimEnd()).toBe(snippets.at(-1));
  });

  it('keeps a long plan readable as complete Markdown sections, a table, and code', () => {
    const plan = [
      '# Plan de trabajo',
      '',
      '## Objetivo',
      '',
      'Mejorar la pantalla sin alterar el comportamiento existente.',
      '',
      '## Cambios',
      '',
      '| Etapa | Trabajo | Resultado |',
      '| --- | --- | --- |',
      '| 1 | Revisar componentes y estilos actuales | Alcance confirmado |',
      '| 2 | Añadir el módulo de inventario y validaciones | Flujo completo |',
      '| 3 | Ejecutar pruebas y corregir regresiones | Cambio verificado |',
      '',
      '### Verificación',
      '',
      '- Probar la navegación en escritorio y móvil.',
      '- Confirmar que los datos anteriores se conservan.',
      '- Ejecutar las pruebas relevantes antes de entregar.',
      '',
      '```ts',
      'export function inventoryCount(items: readonly { quantity: number }[]): number {',
      '  return items.reduce((total, item) => total + item.quantity, 0);',
      '}',
      '```',
      '',
      'El resultado debe conservar todos los apartados y terminar con esta conclusión.'
    ].join('\n');
    const rendered = renderedMarkdown(plan);

    expect(rendered.querySelector('h1')?.textContent).toBe('Plan de trabajo');
    expect(rendered.querySelector('h2')?.textContent).toBe('Objetivo');
    expect(rendered.querySelector('h3')?.textContent).toBe('Verificación');
    expect(rendered.querySelectorAll('table tbody tr')).toHaveLength(3);
    expect(rendered.querySelectorAll('li')).toHaveLength(3);
    expect(rendered.querySelector('.markdown-code pre code')?.textContent).toContain('inventoryCount');
    expect(rendered.textContent).toContain('terminar con esta conclusión.');
  });

  it('formats a C++ study path whose title and phase details arrived as plain paragraphs', () => {
    const rendered = renderedMarkdown([
      'Ruta para aprender C++',
      '',
      '1. Fundamentos del lenguaje (2–4 semanas)',
      '',
      'Aprende variables, tipos, operadores y funciones.',
      '',
      'Practica con ejercicios cortos de entrada y salida.',
      '',
      '2. Estructuras de datos básicas (3–4 semanas)',
      '',
      'Estudia `std::vector`, `std::string`, `std::map` y `std::set`.',
      '',
      '3. Programación orientada a objetos (3–4 semanas)',
      '',
      'Practica clases, encapsulación y polimorfismo.'
    ].join('\n'));

    expect(rendered.querySelector('h2')?.textContent).toBe('Ruta para aprender C++');
    expect(rendered.querySelectorAll('h3')).toHaveLength(3);
    expect(rendered.querySelectorAll('h3 + ul > li')).toHaveLength(4);
  });

  it('does not promote a sentence before a list into a heading', () => {
    const rendered = renderedMarkdown('Here are a few options:\n\n- First option\n- Second option');

    expect(rendered.querySelector('h2')).toBeNull();
    expect(rendered.querySelector('p')?.textContent).toBe('Here are a few options:');
  });

  it('formats a project overview feature label and paragraphs as a Markdown section and list', () => {
    const rendered = renderedMarkdown([
      'El proyecto es una aplicación web para gestionar una librería pequeña.',
      '',
      'Cubre el flujo completo de una librería pequeña:',
      '',
      'Panel con títulos, unidades y alertas de stock bajo.',
      '',
      'Catálogo CRUD con validación de ISBN y existencias.',
      '',
      'Búsqueda por ISBN, título, autora, categoría y stock.',
      '',
      'Carrito con control de stock y confirmación de venta.',
      '',
      'Además incluye verificación de la lógica y pruebas manuales.'
    ].join('\n'));

    expect(rendered.querySelector('p')?.textContent).toContain('aplicación web');
    expect(rendered.querySelector('h3')?.textContent).toBe('Cubre el flujo completo de una librería pequeña');
    expect(rendered.querySelectorAll('h3 + ul > li')).toHaveLength(4);
    expect(rendered.lastElementChild?.textContent).toContain('Además incluye verificación');
  });

  it('formats the plain section labels and summary from the project-components answer', () => {
    const rendered = renderedMarkdown([
      'El proyecto nf17_ui_module_trial es un panel de gastos en JavaScript vanilla, sin framework, así que no tiene componentes en archivos separados: cada sección se genera como HTML dentro de src/app.js.',
      '',
      'Secciones de la interfaz',
      '',
      'Encabezado: título, subtítulo y presupuesto mensual.',
      '',
      'Tarjetas KPI: movimientos, total registrado, presupuesto restante y número de categorías.',
      '',
      'Presupuesto del mes: barra de progreso con estado ok, warning u over.',
      '',
      'Gasto por categoría: lista con importe, porcentaje, barra proporcional y conteo.',
      '',
      'Tendencia mensual: gráfico SVG con línea, puntos y etiquetas de mes.',
      '',
      'Actividad reciente: tabla de movimientos del más reciente al más antiguo.',
      '',
      'Módulos de lógica y datos',
      '',
      'expense-insights.js: summarizeByCategory, remainingBudget, monthlyTrend y la fachada buildInsights.',
      '',
      'seed-data.js: ocho transacciones de ejemplo y presupuesto mensual de 850.',
      '',
      'styles.css: estilos de todas las secciones.',
      '',
      'En resumen: seis secciones visuales y un módulo de cálculo, sin componentes reutilizables.'
    ].join('\n'));

    expect([...rendered.querySelectorAll('h2')].map(heading => heading.textContent)).toEqual([
      'Secciones de la interfaz', 'Módulos de lógica y datos'
    ]);
    expect(rendered.querySelectorAll('h2 + ul > li')).toHaveLength(9);
    expect(rendered.lastElementChild?.querySelector('strong')?.textContent).toBe('En resumen:');
  });

  it('keeps semantic formatting while removing executable attributes and unsafe links', () => {
    const rendered = renderedMessage(
      '<h2 onclick="alert(1)">Heading</h2><p><strong>bold</strong> and <em>italic</em></p>' +
        '<pre><code class="language-ts">const x = 1;</code></pre>' +
        '<a href="javascript:alert(1)" title="unsafe">bad link</a>' +
        '<a href="https://example.com/path" onclick="alert(2)">good link</a>',
      'fallback'
    );
    expect(rendered.querySelector('h2')?.textContent).toBe('Heading');
    expect(rendered.querySelector('strong')?.textContent).toBe('bold');
    expect(rendered.querySelector('pre code')?.textContent).toBe('const x = 1;');
    expect(rendered.querySelector('code')?.getAttribute('class')).toBeNull();
    const links = rendered.querySelectorAll('a');
    expect(links[0]?.getAttribute('href')).toBeNull();
    expect(links[1]?.getAttribute('href')).toBe('https://example.com/path');
    expect(links[1]?.getAttribute('onclick')).toBeNull();
    expect(links[1]?.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('drops SVG, MathML, and script content', () => {
    const rendered = renderedMessage(
      '<p>before</p>' +
        '<svg onload="alert(1)"><foreignObject><p>svg payload</p></foreignObject></svg>' +
        '<math><mtext>math payload</mtext></math>' +
        '<script>alert(2)</script><p>after</p>',
      'fallback'
    );
    expect(rendered.querySelector('svg')).toBeNull();
    expect(rendered.querySelector('math')).toBeNull();
    expect(rendered.querySelector('script')).toBeNull();
    expect(rendered.textContent).toBe('beforeafter');
  });

  it('resolves right-to-left direction on prose blocks', () => {
    const rendered = renderedMarkdown('English introduction.\n\nمرحبا بالعالم 123.\n\nשלום עולם!\n\n- خطوة أولى\n- خطوة ثانية\n\n> اقتباس عربي\n\n```js\nconst name = "مرحبا";\n```');
    expect(rendered.getAttribute('dir')).toBe('auto');
    expect([...rendered.querySelectorAll(':scope > p, ul, blockquote')].map(node => node.getAttribute('dir')))
      .toEqual(['auto', 'auto', 'auto', 'auto', 'auto']);
    expect(rendered.querySelector('blockquote p')?.hasAttribute('dir')).toBe(false);
    expect(rendered.querySelector('pre')?.getAttribute('dir')).toBe('ltr');
    expect(rendered.querySelector('code')?.getAttribute('dir')).toBe('ltr');
    const table = renderedMarkdown('| English | العربية |\n| --- | --- |\n| Hello | مرحبا |');
    expect([...table.querySelectorAll('th, td')].every(node => node.getAttribute('dir') === 'auto')).toBe(true);
  });

  it('preserves safe explicit direction and rejects invalid values', () => {
    const rendered = renderedMessage('<div dir="rtl"><p>English inside an explicitly RTL block.</p><pre><code>const x = 1;</code></pre></div>', '');
    expect(rendered.querySelector('div')?.getAttribute('dir')).toBe('rtl');
    expect(rendered.querySelector('p')?.hasAttribute('dir')).toBe(false);
    expect(rendered.querySelector('pre')?.getAttribute('dir')).toBe('ltr');
    const invalid = renderedMessage('<p dir="javascript:alert(1)">text</p>', 'fallback');
    expect(invalid.querySelector('p')?.getAttribute('dir')).toBe('auto');
  });
});

describe('formulas', () => {
  // Provider math uses inline and block delimiters with escaped surrounding prose.
  const answer = String.raw`**Fórmula de Bhaskara\:**

\[
x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
\]

A identidade de Euler é \(e^{i\pi}+1=0\)\.

\[
A=\begin{pmatrix}
a & b\\
c & d
\end{pmatrix}
\]`;

  it('draws inline and block LaTeX as formulas, not as their source', async () => {
    const rendered = renderedMarkdown(answer);
    await vi.waitFor(() => expect(rendered.querySelector('.math-display .katex-display')).not.toBeNull());
    const blocks = rendered.querySelectorAll('.math-display .katex-display');
    expect(blocks).toHaveLength(2);
    expect(rendered.querySelector('.math-inline .katex')).not.toBeNull();
    // What is drawn, not the source KaTeX keeps for screen readers.
    const shown = [...rendered.querySelectorAll('.katex-html')].map(node => node.textContent).join(' ');
    expect(shown).toContain('±');
    expect(shown).not.toContain(String.raw`\frac`);
    expect(rendered.querySelector('.math-inline')!.parentElement!.textContent).not.toContain(String.raw`\(`);
    // A block formula is its own block, not a paragraph holding one.
    expect(rendered.querySelector('p > .math-display')).toBeNull();
    // The prose around it keeps its Markdown.
    expect(rendered.querySelector('strong')!.textContent).toBe('Fórmula de Bhaskara:');
  });

  it('leaves prices, code and LaTeX it cannot draw as written', () => {
    const rendered = renderedMarkdown('Custa $5 e $10.\n\n`' + String.raw`\(x\)` + '` fica no código.\n\n' + String.raw`\(\frac{1}{\)`);
    expect(rendered.querySelector('.katex')).toBeNull();
    expect(rendered.textContent).toContain('$5 e $10');
    expect(rendered.querySelector('code')!.textContent).toBe(String.raw`\(x\)`);
    expect(rendered.querySelector('.math-inline.is-source')!.textContent).toBe(String.raw`\(\frac{1}{\)`);
  });

  it('keeps a formula from adding links, classes or styles of its own', async () => {
    const rendered = renderedMarkdown(String.raw`\(\href{javascript:alert(1)}{x} \htmlClass{evil}{y} \htmlStyle{color:red}{z}\)`);
    await vi.waitFor(() => expect(rendered.querySelector('.katex')).not.toBeNull());
    expect(rendered.querySelector('.katex')).not.toBeNull();
    expect(rendered.querySelector('a, .evil, [style*="color:red"]')).toBeNull();
  });


});
