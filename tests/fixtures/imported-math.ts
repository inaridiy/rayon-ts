export const OFFSET = 7;

export function importedScale(value: number, factor: number): number {
  return value * factor + OFFSET;
}

export function importedLabel(value: number): string {
  return `value:${value}`;
}
