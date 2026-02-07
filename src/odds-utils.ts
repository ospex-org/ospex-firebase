/**
 * Odds Conversion Utilities for ospex-fdb
 *
 * Converts between American odds (from JsonOdds/Sportspage) and decimal odds.
 * Matches the logic in ospex-agent-server/src/odds-utils.ts.
 */

/**
 * Convert American odds string to decimal format.
 *
 * @param american - American odds string (e.g., "-110", "+150", "225")
 * @returns Decimal odds (e.g., 1.909, 2.50, 3.25)
 *
 * @example
 * americanToDecimal("-110") // 1.909
 * americanToDecimal("+150") // 2.50
 * americanToDecimal("-200") // 1.50
 */
export function americanToDecimal(american: string | number): number {
  const odds = typeof american === 'number' ? american : parseFloat(american);

  if (isNaN(odds) || odds === 0) {
    return 1.0; // Safe default
  }

  if (odds >= 100) {
    // Positive American odds (underdog): +150 -> 2.50
    return (odds / 100) + 1;
  } else if (odds <= -100) {
    // Negative American odds (favorite): -150 -> 1.667
    return (100 / Math.abs(odds)) + 1;
  }

  // Edge case: odds between -100 and +100 shouldn't exist in practice
  return 1.0;
}

/**
 * Parse American odds string to integer.
 * Handles various formats like "-110", "+150", "150", etc.
 *
 * @param american - American odds string
 * @returns Integer American odds (e.g., -110, 150)
 */
export function parseAmericanOdds(american: string | number): number {
  if (typeof american === 'number') {
    return Math.round(american);
  }

  // Remove any non-numeric characters except minus sign
  const cleaned = american.replace(/[^0-9-]/g, '');
  const parsed = parseInt(cleaned, 10);

  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Convert decimal odds back to American format.
 *
 * @param decimal - Decimal odds (e.g., 1.91, 2.50)
 * @returns American odds as integer (e.g., -110, +150)
 */
export function decimalToAmerican(decimal: number): number {
  if (decimal >= 2.0) {
    // Underdog: 2.50 -> +150
    return Math.round((decimal - 1) * 100);
  } else if (decimal > 1.0) {
    // Favorite: 1.667 -> -150
    return Math.round(-100 / (decimal - 1));
  }

  return 0; // Invalid odds
}
