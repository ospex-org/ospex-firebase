/**
 * Slate Sync Module for ospex-fdb
 *
 * Writes game data to the evaluation_slate table in Supabase.
 * Called from monitor.ts after saveOddsToSupabase().
 *
 * IMPORTANT: On upsert, NEVER overwrite the `evaluate` column.
 * That column is user-controlled (force/disable/triage).
 * We only update odds, game_time, synced_at.
 */

import { getSupabaseClient } from './supabase';
import { americanToDecimal, parseAmericanOdds } from './odds-utils';

// Re-use types from monitor.ts (same pattern as oddsHistory.ts)
interface CombinedEvent {
  jsonoddsID: string;
  sportspageID: number;
  Sport: number;
  AwayTeam: string;
  HomeTeam: string;
  MatchTime: { toDate?: () => Date; _seconds?: number } | string;
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

// We only need teams.home.conference from SportspageResult.
// Use a minimal interface to avoid type conflicts with monitor.ts's SportspageResult.
interface SlateGameSportspageData {
  gameId: number;
  teams: {
    away: { conference: string };
    home: { conference: string };
  };
}

/** Maps JSONOdds Sport IDs to league abbreviations */
const SPORT_ID_TO_LEAGUE: Record<number, string> = {
  0: 'MLB',
  1: 'NBA',
  2: 'NCAAB',
  3: 'NCAAF',
  4: 'NFL',
  5: 'NHL',
  8: 'WNBA',
  11: 'MMA',
  24: 'CFL',
};

interface SlateRow {
  jsonodds_id: string;
  league: string;
  sport_id: number;
  home_team: string;
  away_team: string;
  game_time: string;
  source: string;
  synced_at: string;
  // Odds (decimal)
  moneyline_home: number | null;
  moneyline_away: number | null;
  spread_line: number | null;
  spread_home_odds: number | null;
  spread_away_odds: number | null;
  total_line: number | null;
  over_odds: number | null;
  under_odds: number | null;
  has_odds: boolean;
  // Metadata
  conference: string | null;
}

/**
 * Save games to the evaluation_slate table in Supabase.
 *
 * Called from monitor.ts right after saveOddsToSupabase().
 * Uses upsert on jsonodds_id — new games get evaluate=null (triage-decides).
 * On conflict, only updates odds, game_time, synced_at — NEVER overwrites evaluate.
 */
export async function saveSlateToSupabase(
  combinedEvents: CombinedEvent[],
  sportspageResultsMap: Map<number, SlateGameSportspageData>
): Promise<void> {
  if (combinedEvents.length === 0) {
    console.log('[SlateSync] No events to sync');
    return;
  }

  const client = getSupabaseClient();
  const now = new Date().toISOString();
  const rows: SlateRow[] = [];

  for (const event of combinedEvents) {
    const jsonoddsId = event.jsonoddsID?.trim();
    if (!jsonoddsId) continue;

    const sportId = event.Sport;
    const league = SPORT_ID_TO_LEAGUE[sportId];
    if (!league) {
      console.warn(`[SlateSync] Unknown sport ID ${sportId} for ${jsonoddsId}, skipping`);
      continue;
    }

    // Extract game time
    let gameTimeIso: string;
    const mt = event.MatchTime;
    if (typeof mt === 'string') {
      gameTimeIso = new Date(mt).toISOString();
    } else if (mt && typeof mt.toDate === 'function') {
      gameTimeIso = mt.toDate().toISOString();
    } else if (mt && typeof mt._seconds === 'number') {
      gameTimeIso = new Date(mt._seconds * 1000).toISOString();
    } else {
      // Fallback: skip games without a valid time
      console.warn(`[SlateSync] No valid MatchTime for ${jsonoddsId}, skipping`);
      continue;
    }

    // Extract odds (convert American → decimal)
    const mlAway = parseAmericanOdds(event.MoneyLineAway);
    const mlHome = parseAmericanOdds(event.MoneyLineHome);
    const moneylineAway = (mlAway !== 0) ? americanToDecimal(mlAway) : null;
    const moneylineHome = (mlHome !== 0) ? americanToDecimal(mlHome) : null;

    // Spread: away perspective (negative = away favored)
    const spreadAwayNum = parseFloat(event.PointSpreadAway);
    const spreadHomeNum = parseFloat(event.PointSpreadHome);
    const spreadLine = !isNaN(spreadAwayNum) ? spreadAwayNum
      : (!isNaN(spreadHomeNum) ? -spreadHomeNum : null);

    const spreadAwayOddsAm = parseAmericanOdds(event.PointSpreadAwayLine);
    const spreadHomeOddsAm = parseAmericanOdds(event.PointSpreadHomeLine);
    const spreadAwayOdds = (spreadAwayOddsAm !== 0) ? americanToDecimal(spreadAwayOddsAm) : null;
    const spreadHomeOdds = (spreadHomeOddsAm !== 0) ? americanToDecimal(spreadHomeOddsAm) : null;

    const totalNum = parseFloat(event.TotalNumber);
    const totalLine = !isNaN(totalNum) && totalNum > 0 ? totalNum : null;
    const overOddsAm = parseAmericanOdds(event.OverLine);
    const underOddsAm = parseAmericanOdds(event.UnderLine);
    const overOdds = (overOddsAm !== 0) ? americanToDecimal(overOddsAm) : null;
    const underOdds = (underOddsAm !== 0) ? americanToDecimal(underOddsAm) : null;

    const hasOdds = (moneylineAway !== null && moneylineHome !== null)
      || (spreadLine !== null && spreadAwayOdds !== null && spreadHomeOdds !== null)
      || (totalLine !== null && overOdds !== null && underOdds !== null);

    // Conference from Sportspage data (if available)
    let conference: string | null = null;
    const spResult = sportspageResultsMap.get(event.sportspageID);
    if (spResult?.teams?.home?.conference) {
      // Use home team's conference (both teams usually in same conference for conf games)
      conference = spResult.teams.home.conference;
    }

    rows.push({
      jsonodds_id: jsonoddsId,
      league,
      sport_id: sportId,
      home_team: event.HomeTeam,
      away_team: event.AwayTeam,
      game_time: gameTimeIso,
      source: 'monitor_sync',
      synced_at: now,
      moneyline_home: moneylineHome,
      moneyline_away: moneylineAway,
      spread_line: spreadLine,
      spread_home_odds: spreadHomeOdds,
      spread_away_odds: spreadAwayOdds,
      total_line: totalLine,
      over_odds: overOdds,
      under_odds: underOdds,
      has_odds: hasOdds,
      conference,
    });
  }

  if (rows.length === 0) {
    console.log('[SlateSync] No valid rows to upsert');
    return;
  }

  // Split into new inserts vs existing updates.
  // CRITICAL: We cannot use plain upsert because it would overwrite user-controlled
  // columns (evaluate, max_eval_count, eval_interval_minutes, current_eval_count,
  // last_eval_at, source_notes). Instead:
  // - New rows: INSERT with all defaults (evaluate=null, etc.)
  // - Existing rows: UPDATE only odds, game_time, synced_at, conference

  // 1. Find which jsonodds_ids already exist
  const allIds = rows.map(r => r.jsonodds_id);
  const existingIds = new Set<string>();

  // Query in chunks of 100 (Supabase IN filter limit)
  for (let i = 0; i < allIds.length; i += 100) {
    const chunk = allIds.slice(i, i + 100);
    const { data: existing } = await client
      .from('evaluation_slate')
      .select('jsonodds_id')
      .in('jsonodds_id', chunk);

    if (existing) {
      for (const row of existing) {
        existingIds.add(row.jsonodds_id);
      }
    }
  }

  const newRows = rows.filter(r => !existingIds.has(r.jsonodds_id));
  const updateRows = rows.filter(r => existingIds.has(r.jsonodds_id));
  let insertedCount = 0;
  let updatedCount = 0;

  // 2. INSERT new rows (these get defaults: evaluate=null, current_eval_count=0, etc.)
  const BATCH_SIZE = 100;
  for (let i = 0; i < newRows.length; i += BATCH_SIZE) {
    const batch = newRows.slice(i, i + BATCH_SIZE);
    const { error } = await client
      .from('evaluation_slate')
      .insert(batch);

    if (error) {
      // Handle race condition: another sync may have inserted between our check and insert
      if (error.code === '23505') {
        console.log(`[SlateSync] Some rows already existed (race condition), continuing`);
      } else {
        console.error(`[SlateSync] Error inserting batch ${i}-${i + batch.length}:`, error.message);
      }
    } else {
      insertedCount += batch.length;
    }
  }

  // 3. UPDATE existing rows — only sync-safe columns
  for (const row of updateRows) {
    const { error } = await client
      .from('evaluation_slate')
      .update({
        league: row.league,
        sport_id: row.sport_id,
        home_team: row.home_team,
        away_team: row.away_team,
        game_time: row.game_time,
        synced_at: row.synced_at,
        moneyline_home: row.moneyline_home,
        moneyline_away: row.moneyline_away,
        spread_line: row.spread_line,
        spread_home_odds: row.spread_home_odds,
        spread_away_odds: row.spread_away_odds,
        total_line: row.total_line,
        over_odds: row.over_odds,
        under_odds: row.under_odds,
        has_odds: row.has_odds,
        conference: row.conference,
      })
      .eq('jsonodds_id', row.jsonodds_id);

    if (error) {
      console.error(`[SlateSync] Error updating ${row.jsonodds_id}:`, error.message);
    } else {
      updatedCount++;
    }
  }

  console.log(`[SlateSync] Inserted ${insertedCount} new, updated ${updatedCount} existing (${rows.length} total games)`);

  // Deactivate past games (2+ hours after start time, only triage-decides games)
  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: deactivated } = await client
      .from('evaluation_slate')
      .update({ evaluate: false })
      .lt('game_time', cutoff)
      .is('evaluate', null)
      .select('id');

    const deactivatedCount = deactivated?.length ?? 0;
    if (deactivatedCount > 0) {
      console.log(`[SlateSync] Deactivated ${deactivatedCount} past games`);
    }
  } catch (cleanupError) {
    console.warn('[SlateSync] Error during past-game cleanup:', cleanupError);
  }
}
