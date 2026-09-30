// Keeps an in-progress form edit when an unrelated main-process push carries the old value.
export function applyChatValue(
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
  previous: string | number | undefined,
): void {
  if (
    document.activeElement === input &&
    previous !== undefined &&
    input.value !== String(previous)
  )
    return;
  input.value = value;
}

// Preserves an in-progress checkbox edit.
export function applyChatChecked(
  input: HTMLInputElement,
  value: boolean,
  previous: boolean | undefined,
): void {
  if (
    document.activeElement === input &&
    previous !== undefined &&
    input.checked !== previous
  )
    return;
  input.checked = value;
}
