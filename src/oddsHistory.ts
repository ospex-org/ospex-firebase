/**
 * Odds History Module for ospex-fdb
 *
 * Saves odds snapshots to Supabase:
 * - Current odds from JsonOdds (every 30 min)
 * - Opening lines from Sportspage (on first capture only)
 *
 * Called from monitor.ts after saveDataToFirestore().
 */

import { getSupabaseClient } from './supabase';
import { americanToDecimal, parseAmericanOdds } from './odds-utils';

// Re-use types from monitor.ts
// These match the interfaces defined in monitor.ts
interface CombinedEvent {
  jsonoddsID: string;
  sportspageID: number;
  MoneyLineAway: string;
  MoneyLineHome: string;
  OverLine: string;
  TotalNumber: string;
  UnderLine: string;
  PointSpreadAway: string;
  PointSpreadHome: string;
  PointSpreadAwayLine: string;
  PointSpreadHomeLine: string;
}

interface SportspageLine {
  away: number;
  home: number;
  awayOdds: number;
  homeOdds: number;
}

interface SportspageMoneylineDetails {
  awayOdds: number;
  homeOdds: number;
}

interface SportspageTotalDetails {
  total: number;
  overOdds: number;
  underOdds: number;
}

interface SportspageOdds {
  spread: {
    open: SportspageLine;
    current: SportspageLine;
  };
  moneyline: {
    open: SportspageMoneylineDetails;
    current: SportspageMoneylineDetails;
  };
  total: {
    open: SportspageTotalDetails;
    current: SportspageTotalDetails;
  };
}

interface SportspageResult {
  gameId: number;
  odds: SportspageOdds[];
}

/**
 * Row structure for odds_history table.
 */
interface OddsHistoryRow {
  jsonodds_id: string;
  sportspage_id: number | null;
  market: 'spread' | 'total' | 'moneyline';
  line: number | null;
  away_odds_american: number | null;
  away_odds_decimal: number | null;
  home_odds_american: number | null;
  home_odds_decimal: number | null;
  source: 'jsonodds' | 'sportspage_open';
  captured_at: string;
}

/**
 * Check if this is the first odds capture for a contest.
 * Used to determine whether to also save the Sportspage opener.
 */
async function isFirstCapture(jsonoddsId: string): Promise<boolean> {
  const client = getSupabaseClient();

  const { count, error } = await client
    .from('odds_history')
    .select('*', { count: 'exact', head: true })
    .eq('jsonodds_id', jsonoddsId);

  if (error) {
    console.error(`[OddsHistory] Error checking first capture for ${jsonoddsId}:`, error);
    return false; // Fail safe - don't duplicate openers
  }

  return count === 0;
}

/**
 * Build odds history rows from JsonOdds current data.
 * Creates one row per market type (moneyline, spread, total).
 */
function buildCurrentOddsRows(event: CombinedEvent, capturedAt: string): OddsHistoryRow[] {
  const rows: OddsHistoryRow[] = [];

  // Moneyline
  if (event.MoneyLineAway && event.MoneyLineHome) {
    const awayAmerican = parseAmericanOdds(event.MoneyLineAway);
    const homeAmerican = parseAmericanOdds(event.MoneyLineHome);

    if (awayAmerican !== 0 && homeAmerican !== 0) {
      rows.push({
        jsonodds_id: event.jsonoddsID,
        sportspage_id: event.sportspageID,
        market: 'moneyline',
        line: null,
        away_odds_american: awayAmerican,
        away_odds_decimal: americanToDecimal(awayAmerican),
        home_odds_american: homeAmerican,
        home_odds_decimal: americanToDecimal(homeAmerican),
        source: 'jsonodds',
        captured_at: capturedAt,
      });
    }
  }

  // Spread
  if (event.PointSpreadHome && event.PointSpreadAwayLine && event.PointSpreadHomeLine) {
    const spreadLine = parseFloat(event.PointSpreadHome);
    const awayAmerican = parseAmericanOdds(event.PointSpreadAwayLine);
    const homeAmerican = parseAmericanOdds(event.PointSpreadHomeLine);

    if (!isNaN(spreadLine) && awayAmerican !== 0 && homeAmerican !== 0) {
      rows.push({
        jsonodds_id: event.jsonoddsID,
        sportspage_id: event.sportspageID,
        market: 'spread',
        line: spreadLine,
        away_odds_american: awayAmerican,
        away_odds_decimal: americanToDecimal(awayAmerican),
        home_odds_american: homeAmerican,
        home_odds_decimal: americanToDecimal(homeAmerican),
        source: 'jsonodds',
        captured_at: capturedAt,
      });
    }
  }

  // Total
  if (event.TotalNumber && event.OverLine && event.UnderLine) {
    const totalLine = parseFloat(event.TotalNumber);
    const overAmerican = parseAmericanOdds(event.OverLine); // Over = away position
    const underAmerican = parseAmericanOdds(event.UnderLine); // Under = home position

    if (!isNaN(totalLine) && overAmerican !== 0 && underAmerican !== 0) {
      rows.push({
        jsonodds_id: event.jsonoddsID,
        sportspage_id: event.sportspageID,
        market: 'total',
        line: totalLine,
        away_odds_american: overAmerican, // Over = away
        away_odds_decimal: americanToDecimal(overAmerican),
        home_odds_american: underAmerican, // Under = home
        home_odds_decimal: americanToDecimal(underAmerican),
        source: 'jsonodds',
        captured_at: capturedAt,
      });
    }
  }

  return rows;
}

/**
 * Build opener rows from Sportspage data.
 * Called only on first capture for a contest.
 */
function buildOpenerRows(
  jsonoddsId: string,
  sportspageId: number,
  sportspageOdds: SportspageOdds,
  capturedAt: string
): OddsHistoryRow[] {
  const rows: OddsHistoryRow[] = [];

  // Moneyline opener
  if (sportspageOdds.moneyline?.open) {
    const ml = sportspageOdds.moneyline.open;
    if (ml.awayOdds && ml.homeOdds) {
      rows.push({
        jsonodds_id: jsonoddsId,
        sportspage_id: sportspageId,
        market: 'moneyline',
        line: null,
        away_odds_american: ml.awayOdds,
        away_odds_decimal: americanToDecimal(ml.awayOdds),
        home_odds_american: ml.homeOdds,
        home_odds_decimal: americanToDecimal(ml.homeOdds),
        source: 'sportspage_open',
        captured_at: capturedAt,
      });
    }
  }

  // Spread opener
  if (sportspageOdds.spread?.open) {
    const sp = sportspageOdds.spread.open;
    if (sp.home !== undefined && sp.awayOdds && sp.homeOdds) {
      rows.push({
        jsonodds_id: jsonoddsId,
        sportspage_id: sportspageId,
        market: 'spread',
        line: sp.home, // Sportspage uses home team spread
        away_odds_american: sp.awayOdds,
        away_odds_decimal: americanToDecimal(sp.awayOdds),
        home_odds_american: sp.homeOdds,
        home_odds_decimal: americanToDecimal(sp.homeOdds),
        source: 'sportspage_open',
        captured_at: capturedAt,
      });
    }
  }

  // Total opener
  if (sportspageOdds.total?.open) {
    const tot = sportspageOdds.total.open;
    if (tot.total !== undefined && tot.overOdds && tot.underOdds) {
      rows.push({
        jsonodds_id: jsonoddsId,
        sportspage_id: sportspageId,
        market: 'total',
        line: tot.total,
        away_odds_american: tot.overOdds, // Over = away
        away_odds_decimal: americanToDecimal(tot.overOdds),
        home_odds_american: tot.underOdds, // Under = home
        home_odds_decimal: americanToDecimal(tot.underOdds),
        source: 'sportspage_open',
        captured_at: capturedAt,
      });
    }
  }

  return rows;
}

/**
 * Save odds snapshots to Supabase.
 *
 * Called after saveDataToFirestore() in monitor().
 * For each contest:
 * - Always saves current JsonOdds snapshot
 * - On first capture, also saves Sportspage opening lines
 *
 * @param combinedEvents - Combined event data from processEventData
 * @param sportspageResultsMap - Map of sportspageId -> SportspageResult for opener lookup
 */
export async function saveOddsToSupabase(
  combinedEvents: CombinedEvent[],
  sportspageResultsMap: Map<number, SportspageResult>
): Promise<void> {
  if (combinedEvents.length === 0) {
    console.log('[OddsHistory] No events to save');
    return;
  }

  const client = getSupabaseClient();
  const capturedAt = new Date().toISOString();
  const allRows: OddsHistoryRow[] = [];

  // Track stats
  let openerCount = 0;
  let currentCount = 0;

  for (const event of combinedEvents) {
    // Always add current JsonOdds snapshot
    const currentRows = buildCurrentOddsRows(event, capturedAt);
    allRows.push(...currentRows);
    currentCount += currentRows.length;

    // Check if first capture - if so, also add Sportspage openers
    const isFirst = await isFirstCapture(event.jsonoddsID);
    if (isFirst && event.sportspageID) {
      const spResult = sportspageResultsMap.get(event.sportspageID);
      if (spResult?.odds?.[0]) {
        const openerRows = buildOpenerRows(
          event.jsonoddsID,
          event.sportspageID,
          spResult.odds[0],
          capturedAt
        );
        allRows.push(...openerRows);
        openerCount += openerRows.length;
      }
    }
  }

  if (allRows.length === 0) {
    console.log('[OddsHistory] No valid odds rows to save');
    return;
  }

  // Batch insert
  // Using upsert to handle the unique constraint gracefully
  const { error } = await client
    .from('odds_history')
    .insert(allRows);

  if (error) {
    // If it's a unique constraint violation, that's okay (duplicate timing)
    if (error.code === '23505') {
      console.log(`[OddsHistory] Some rows already existed (duplicate timing), continuing`);
    } else {
      console.error('[OddsHistory] Error saving odds history:', error);
      throw error;
    }
  } else {
    console.log(
      `[OddsHistory] Saved ${allRows.length} rows (${currentCount} current, ${openerCount} openers)`
    );
  }
}
