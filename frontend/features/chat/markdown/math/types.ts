export interface MathFormula {
  tex: string;
  display: boolean;
}

export interface MathSlots {
  formulas: MathFormula[];
}

const OPEN = '';
const CLOSE = '';

export function reserveFormula(slots: MathSlots, tex: string, display: boolean): string {
  const index = slots.formulas.push({ tex: tex.trim(), display }) - 1;
  return `${OPEN}${index}${CLOSE}`;
}

export const formulaSlotPattern = /(\d{1,5})/g;
