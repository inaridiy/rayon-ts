// @ts-expect-error resolved by the Vite RegExp alias exercised in e2e.test.ts
import { IMPORTED_BONUS } from "@fixture/imported-bonus.ts";

export function importedScore(value: number): number {
  return value * 3 + 1 + IMPORTED_BONUS;
}
