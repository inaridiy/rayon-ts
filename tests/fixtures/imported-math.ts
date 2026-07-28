export const OFFSET = 7;

export function importedScale(value: number, factor: number): number {
  return value * factor + OFFSET;
}

export function importedLabel(value: number): string {
  return `value:${value}`;
}

let counter = 0;

export function nextImportedCount(): number {
  counter += 1;
  return counter;
}
