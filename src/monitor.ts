import * as schedule from 'node-schedule'
import * as admin from 'firebase-admin'
import * as dotenv from 'dotenv'
import axios from 'axios'
import { json } from 'express'
import { saveOddsToSupabase } from './oddsHistory'
import { saveSlateToSupabase } from './slateSync'

dotenv.config()

interface RundownResponse {
  meta: {
    delta_last_id: string;
  }
  events: RundownEvent[]
}

interface RundownEvent {
  event_id: string;
  event_uuid: string;
  sport_id: number;
  event_date: string;
  rotation_number_away: number;
  rotation_number_home: number;
  score: RundownScore
  teams: RundownTeam[]
  teams_normalized: RundownNormalizedTeam[]
  schedule: RundownSchedule
  lines: object
}

interface RundownScore {
  event_id: string
  event_status: string
  winner_away: number
  winner_home: number
  score_away: number
  score_home: number
  score_away_by_period: number[]
  score_home_by_period: number[]
  venue_name: string
  venue_location: string
  game_clock: number
  display_clock: string
  game_period: number
  broadcast: string
  event_status_detail: string
  updated_at: string
}

interface RundownTeam {
  team_id: number
  team_normalized_id: number
  name: string
  is_away: boolean
  is_home: boolean
}

interface RundownNormalizedTeam {
  team_id: number
  name: string
  mascot: string
  abbreviation: string
  conference_id: number
  division_id: number
  ranking: number
  record: string
  is_away: boolean
  is_home: boolean
  conference: RundownConference
  division: RundownDivision
}

interface RundownConference {
  conference_id: number
  sport_id: number
  name: string
}

interface RundownDivision {
  division_id: number
  conference_id: number
  sport_id: number
  name: string
}

interface RundownSchedule {
  league_name: string
  conference_competition: boolean
  season_type: string
  season_year: number
  event_headline: string
  event_name: string
  attendance: string
}

interface SportspageResponse {
  status: number
  time: string
  games: number
  skip: number
  results: SportspageResult[]
}

interface SportspageResult {
  schedule: {
    date: string
    tbaTime: boolean
  }
  summary: string
  details: {
    league: string
    seasonType: string
    season: number
    conferenceGame: boolean
    divisionGame: boolean
  }
  status: string
  teams: {
    away: SportspageTeam
    home: SportspageTeam
  }
  lastUpdated: string
  gameId: number
  odds: SportspageOdds[]
  venue: {
    name: string
    city: string
    state: string
    neutralSite: boolean
  }
}

interface SportspageTeam {
  team: string
  location: string
  mascot: string
  abbreviation: string
  conference: string
  division: string
}

interface SportspageOdds {
  spread: SportspageSpread
  moneyline: SportspageMoneyline
  total: SportspageTotal
  openDate: string
  lastUpdated: string
}

interface SportspageSpread {
  open: SportspageLine
  current: SportspageLine
}

interface SportspageMoneyline {
  open: SportspageMoneylineDetails
  current: SportspageMoneylineDetails
}

interface SportspageTotal {
  open: SportspageTotalDetails
  current: SportspageTotalDetails
}

interface SportspageLine {
  away: number
  home: number
  awayOdds: number
  homeOdds: number
}

interface SportspageMoneylineDetails {
  awayOdds: number
  homeOdds: number
}

interface SportspageTotalDetails {
  total: number
  overOdds: number
  underOdds: number
}

interface JsonoddsResponse {
  ID: string
  HomeTeam: string
  AwayTeam: string
  Sport: number
  MatchTime: string
  HomePitcher?: string
  AwayPitcher?: string
  HomeROT?: string
  AwayROT?: string
  League?: { Name: string }
  DisplayLeague?: string
  Odds: JsonoddsOdds[]
}

interface JsonoddsOdds {
  ID: string
  EventID: string
  OddType: string
  MoneyLineAway: string
  MoneyLineHome: string
  OverLine: string
  TotalNumber: string
  UnderLine: string
  PointSpreadAway: string
  PointSpreadHome: string
  PointSpreadAwayLine: string
  PointSpreadHomeLine: string
  DrawLine: string
  SiteID: number
  LastUpdated: string
}

interface CombinedEvent {
  jsonoddsID: string
  rundownID: string
  sportspageID: number
  Sport: number
  AwayTeam: string
  HomeTeam: string
  MatchTime: admin.firestore.Timestamp
  OddType: string
  // Comprehensive odds data from JsonOdds
  MoneyLineAway: string
  MoneyLineHome: string
  OverLine: string
  TotalNumber: string
  UnderLine: string
  PointSpreadAway: string
  PointSpreadHome: string
  PointSpreadAwayLine: string
  PointSpreadHomeLine: string
  // Additional JsonOdds data
  HomePitcher: string | undefined
  AwayPitcher: string | undefined
  HomeROT: string | undefined
  AwayROT: string | undefined
  LastUpdated: admin.firestore.Timestamp
  Created: boolean
  status: string
  // Final score/status (derived primarily from Rundown; Sportspage used as secondary signal)
  awayScore?: number
  homeScore?: number
  isFinal: boolean
  scoredAt?: admin.firestore.Timestamp
  eventStatus?: string
  eventStatusDetail?: string
  sportspageStatus?: string
}

interface TeamAlias {
  league: number
  aliases: string[]
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT_KEY || '{}'))
})

const db = admin.firestore()
db.settings({ ignoreUndefinedProperties: true })

const teamNameAliases = new Map<string, TeamAlias[]>([
  // NBA
  ["Los Angeles Clippers", [{ league: 1, aliases: ["LA Clippers", "Los Angeles Clippers"] }]],
  ["Portland Trail Blazers", [{ league: 1, aliases: ["Portland Trailblazers", "Portland Trail Blazers"] }]],
  // NCAAB disambiguation
  ["Miami Florida", [{ league: 2, aliases: ["Miami (FL)", "Miami Florida"] }]],
  ["Miami Ohio", [{ league: 2, aliases: ["Miami (OH)", "Miami Ohio"] }]],
  // NCAAB + NCAAF (multi-sport aliases)
  ["Ole Miss", [
    { league: 2, aliases: ["Ole Miss", "Mississippi"] },
    { league: 3, aliases: ["Ole Miss", "Mississippi"] },
  ]],
  ["SMU", [
    { league: 2, aliases: ["SMU", "Southern Methodist"] },
    { league: 3, aliases: ["SMU", "Southern Methodist"] },
  ]],
  ["USC", [
    { league: 2, aliases: ["USC", "Southern California"] },
    { league: 3, aliases: ["USC", "Southern California"] },
  ]],
  ["LSU", [
    { league: 2, aliases: ["LSU", "Louisiana State"] },
    { league: 3, aliases: ["LSU", "Louisiana State"] },
  ]],
  ["UCF", [
    { league: 2, aliases: ["UCF", "Central Florida"] },
    { league: 3, aliases: ["UCF", "Central Florida"] },
  ]],
  ["UNLV", [
    { league: 2, aliases: ["UNLV", "Nevada-Las Vegas"] },
    { league: 3, aliases: ["UNLV", "Nevada-Las Vegas"] },
  ]],
  ["BYU", [
    { league: 2, aliases: ["BYU", "Brigham Young"] },
    { league: 3, aliases: ["BYU", "Brigham Young"] },
  ]],
  ["TCU", [
    { league: 2, aliases: ["TCU", "Texas Christian"] },
    { league: 3, aliases: ["TCU", "Texas Christian"] },
  ]],
  ["FIU", [
    { league: 2, aliases: ["FIU", "Florida International"] },
    { league: 3, aliases: ["FIU", "Florida International"] },
  ]],
  ["App State", [
    { league: 2, aliases: ["App State", "Appalachian State"] },
    { league: 3, aliases: ["App State", "Appalachian State"] },
  ]],
  ["UTSA", [
    { league: 2, aliases: ["UTSA", "UT San Antonio"] },
    { league: 3, aliases: ["UTSA", "UT San Antonio"] },
  ]],
  ["Pittsburgh", [
    { league: 2, aliases: ["Pittsburgh", "Pitt"] },
    { league: 3, aliases: ["Pittsburgh", "Pitt"] },
  ]],
  ["UConn", [
    { league: 2, aliases: ["UConn", "Connecticut"] },
    { league: 3, aliases: ["UConn", "Connecticut"] },
  ]],
  ["NC State", [
    { league: 2, aliases: ["NC State", "North Carolina State"] },
    { league: 3, aliases: ["NC State", "North Carolina State"] },
  ]],
  // NCAAB only
  ["VCU", [{ league: 2, aliases: ["VCU", "Virginia Commonwealth"] }]],
  ["UMass", [{ league: 2, aliases: ["UMass", "Massachusetts"] }]],
  ["ETSU", [{ league: 2, aliases: ["ETSU", "East Tennessee State"] }]],
  ["VMI", [{ league: 2, aliases: ["VMI", "Virginia Military"] }]],
  ["LIU", [{ league: 2, aliases: ["LIU", "Long Island", "Long Island University"] }]],
  ["UMBC", [{ league: 2, aliases: ["UMBC", "Maryland-Baltimore County"] }]],
  ["SIU", [{ league: 2, aliases: ["SIU", "Southern Illinois"] }]],
  ["UAlbany", [{ league: 2, aliases: ["UAlbany", "Albany"] }]],
  ["UL Monroe", [{ league: 2, aliases: ["UL Monroe", "Louisiana-Monroe"] }]],
  ["SE Louisiana", [{ league: 2, aliases: ["SE Louisiana", "Southeastern Louisiana"] }]],
  ["Loyola Chicago", [{ league: 2, aliases: ["Loyola Chicago", "Loyola-Chicago"] }]],
  ["UMass Lowell", [{ league: 2, aliases: ["UMass Lowell", "Massachusetts-Lowell"] }]],
  ["Saint Mary's", [{ league: 2, aliases: ["Saint Mary's", "St. Mary's", "Saint Marys CA", "St. Mary's (CA)"] }]],
  ["Saint Joseph's", [{ league: 2, aliases: ["Saint Joseph's", "St. Joseph's"] }]],
  ["Saint Peter's", [{ league: 2, aliases: ["Saint Peter's", "St. Peter's"] }]],
  ["Saint Bonaventure", [{ league: 2, aliases: ["Saint Bonaventure", "St. Bonaventure"] }]],
])

const sportsConfig = {
  MLB: {
    preseasonStart: '2024-12-31', // TBD
    preseasonEnd: '2024-12-31', // TBD
    seasonStart: '2025-04-01',
    seasonEnd: '2025-10-31',
    postseasonStart: '2024-11-01',
    postseasonEnd: '2024-12-15',
    daysAheadPreseason: 2,
    daysAheadRegular: 2,
    daysAheadPostseason: 2,
    jsonoddsId: 0,
    rundownId: 3
  },
  NBA: {
    preseasonStart: '2024-10-03', // TBD
    preseasonEnd: '2024-10-21', // TBD
    seasonStart: '2025-10-20',
    seasonEnd: '2026-04-13',
    postseasonStart: '2025-01-01', // TBD
    postseasonEnd: '2025-01-01', // TBD
    daysAheadPreseason: 1,
    daysAheadRegular: 2,
    daysAheadPostseason: 3,
    jsonoddsId: 1,
    rundownId: 4
  },
  NCAAB: {
    preseasonStart: '2024-12-31', // TBD
    preseasonEnd: '2024-12-31', // TBD
    seasonStart: '2025-11-03',
    seasonEnd: '2026-03-15',
    postseasonStart: '2024-03-18',
    postseasonEnd: '2024-04-08',
    daysAheadPreseason: 10,
    daysAheadRegular: 2,
    daysAheadPostseason: 7,
    jsonoddsId: 2,
    rundownId: 5
  },
  NCAAF: {
    preseasonStart: '2024-12-31', // TBD
    preseasonEnd: '2024-12-31', // TBD
    seasonStart: '2025-09-01',
    seasonEnd: '2025-12-13',
    postseasonStart: '2025-12-14',
    postseasonEnd: '2026-01-19',
    daysAheadPreseason: 1,
    daysAheadRegular: 3,
    daysAheadPostseason: 3,
    jsonoddsId: 3,
    rundownId: 1
  },
  NFL: {
    preseasonStart: '2025-08-01',
    preseasonEnd: '2025-08-23',
    seasonStart: '2025-09-04',
    seasonEnd: '2026-01-07',
    postseasonStart: '2026-01-09',
    postseasonEnd: '2026-02-10', // Extended past Super Bowl Sunday (Feb 8) to account for UTC midnight comparison
    daysAheadPreseason: 3,
    daysAheadRegular: 3,
    daysAheadPostseason: 3,
    jsonoddsId: 4,
    rundownId: 2
  },
  NHL: {
    preseasonStart: '2024-12-31', // TBD
    preseasonEnd: '2024-12-31', // TBD
    seasonStart: '2025-10-08',
    seasonEnd: '2026-04-16',
    postseasonStart: '2024-04-19',
    postseasonEnd: '2024-06-30',
    daysAheadPreseason: 10,
    daysAheadRegular: 3,
    daysAheadPostseason: 7,
    jsonoddsId: 5,
    rundownId: 6
  },
  WNBA: {
    preseasonStart: '2024-12-31', // TBD
    preseasonEnd: '2024-12-31', // TBD
    seasonStart: '2024-12-31',
    seasonEnd: '2024-12-31',
    postseasonStart: '2024-12-31',
    postseasonEnd: '2024-12-31',
    daysAheadPreseason: 10,
    daysAheadRegular: 3,
    daysAheadPostseason: 7,
    jsonoddsId: 8,
    rundownId: 8
  }
}

function getSeasonPhaseAndDaysAhead(sport: keyof typeof sportsConfig): { phase: string, daysAhead: number } {
  const currentDate = new Date()
  const config = sportsConfig[sport]
  const preseasonStart = new Date(config.preseasonStart)
  const preseasonEnd = new Date(config.preseasonEnd)
  const seasonStart = new Date(config.seasonStart)
  const seasonEnd = new Date(config.seasonEnd)
  const postseasonStart = new Date(config.postseasonStart)
  const postseasonEnd = new Date(config.postseasonEnd)

  if (currentDate >= preseasonStart && currentDate <= preseasonEnd) {
    return { phase: 'preseason', daysAhead: config.daysAheadPreseason }
  } else if (currentDate >= seasonStart && currentDate <= seasonEnd) {
    return { phase: 'regular', daysAhead: config.daysAheadRegular }
  } else if (currentDate >= postseasonStart && currentDate <= postseasonEnd) {
    return { phase: 'postseason', daysAhead: config.daysAheadPostseason }
  } else {
    return { phase: 'offseason', daysAhead: 0 }
  }
}

function isSeasonActive(sport: keyof typeof sportsConfig): boolean {
  const today = new Date()
  const preseasonStart = new Date(sportsConfig[sport].preseasonStart)
  const preseasonEnd = new Date(sportsConfig[sport].preseasonEnd)
  const seasonStart = new Date(sportsConfig[sport].seasonStart)
  const seasonEnd = new Date(sportsConfig[sport].seasonEnd)
  const postseasonStart = new Date(sportsConfig[sport].postseasonStart)
  const postseasonEnd = new Date(sportsConfig[sport].postseasonEnd)

  return (today >= preseasonStart && today <= preseasonEnd) ||
    (today >= seasonStart && today <= seasonEnd) ||
    (today >= postseasonStart && today <= postseasonEnd)
}

const standardizeTeamName = (name: string, league: number): string => {
  for (const [standardName, leagueAliases] of teamNameAliases) {
    const leagueAlias = leagueAliases.find(alias => alias.league === league)
    if (leagueAlias && leagueAlias.aliases.includes(name)) {
      return standardName
    }
  }
  return name // Return the original name if no alias is found
}

const getDatesForNextNDays = (days: number): string[] => {
  const dates = []
  console.log(`Fetching dates for next ${days} days`)
  for (let i = 0; i < days; i++) {
    const date = new Date()
    date.setHours(date.getHours() - new Date().getTimezoneOffset() / 60 - 5) // Adjusted for EST (UTC-5), may change later
    date.setDate(date.getDate() + i)
    const formattedDate = date.toISOString().split('T')[0] // Format the date as 'YYYY-MM-DD'
    dates.push(formattedDate)
    console.log(`Added date: ${formattedDate}`)
  }
  return dates
}

const fetchExistingContestsFromFirestore = async (): Promise<CombinedEvent[]> => {
  const snapshot = await db.collection('contests').get()
  return snapshot.docs.map(doc => doc.data() as CombinedEvent)
}

function getTeamNameForSport(sport: number, name: string, mascot?: string): string {
  // Rules for sports that should include the mascot in the team name
  const sportsWithMascot = [0, 1, 4, 5, 8] // MLB, NBA, NFL, NHL, WNBA (JsonOdds IDs)

  // If the sport requires mascot, append it to the team name
  if (sportsWithMascot.includes(sport) && mascot) {
    return standardizeTeamName(`${name} ${mascot}`, sport)
  } else {
    return standardizeTeamName(name, sport)
  }
}

const processEventData = (
  jsonoddsData: JsonoddsResponse[],
  rundownData: RundownResponse,
  sportspageData: SportspageResponse,
  existingContests: CombinedEvent[]
): (CombinedEvent | undefined)[] => {
  return jsonoddsData.map((jsonoddsEvent: JsonoddsResponse) => {
    const jsonoddsHomeTeam = standardizeTeamName(jsonoddsEvent.HomeTeam, jsonoddsEvent.Sport)
    const jsonoddsAwayTeam = standardizeTeamName(jsonoddsEvent.AwayTeam, jsonoddsEvent.Sport)
    const jsonoddsMatchDateTime = new Date(jsonoddsEvent.MatchTime + 'Z') // Parse the JsonOdds match time as UTC
    const jsonoddsMatchDateHour = new Date(
      jsonoddsMatchDateTime.getUTCFullYear(),
      jsonoddsMatchDateTime.getUTCMonth(),
      jsonoddsMatchDateTime.getUTCDate(),
      jsonoddsMatchDateTime.getUTCHours()
    )
    // console.log(`JsonOdds Event: ${jsonoddsEvent.ID}`)
    // console.log(`Standardized names: Home - ${jsonoddsHomeTeam}, Away - ${jsonoddsAwayTeam}`)
    // console.log(`JsonOdds Match Time: ${jsonoddsMatchDateTime.toISOString()}`)

    const rundownEvent = rundownData.events.find((event: RundownEvent) => {
      // Check if teams array is defined and has at least two elements
      // console.log(`Rundown Event: ${event.event_id}`)
      if (!event.teams || event.teams.length < 2) {
        // console.log(`Returning false event teams does not exist or is less than 2`)
        return false // Skip this event if teams data is not adequate
      }

      const eventHomeTeam = getTeamNameForSport(jsonoddsEvent.Sport, event.teams_normalized[1].name, event.teams_normalized[1].mascot)
      const eventAwayTeam = getTeamNameForSport(jsonoddsEvent.Sport, event.teams_normalized[0].name, event.teams_normalized[0].mascot)
      const eventDateTime = new Date(event.event_date)
      const eventMatchDateHour = new Date(
        eventDateTime.getUTCFullYear(),
        eventDateTime.getUTCMonth(),
        eventDateTime.getUTCDate(),
        eventDateTime.getUTCHours()
      )

      // console.log(`Rundown Team Names: Home - ${event.teams_normalized[1].name} ${event.teams_normalized[1].mascot}, Away - ${event.teams_normalized[0].name} ${event.teams_normalized[0].mascot}`)
      // console.log(`Rundown Match Time: ${new Date(event.event_date).toISOString()}`)

      if (eventHomeTeam === jsonoddsHomeTeam && eventAwayTeam === jsonoddsAwayTeam && eventMatchDateHour.getTime() === jsonoddsMatchDateHour.getTime()) {
        // console.log(`Match found for JsonOdds event ${jsonoddsEvent.ID}: Rundown event ${event.event_id}`);
        return true;
      } else {
        // console.log(`Comparing JsonOdds event ${jsonoddsEvent.ID} with Rundown event ${event.event_id}`);
        // console.log(`JsonOdds: Home - ${jsonoddsHomeTeam}, Away - ${jsonoddsAwayTeam}, Time - ${jsonoddsMatchDateHour.toISOString()}`);
        // console.log(`Rundown: Home - ${eventHomeTeam}, Away - ${eventAwayTeam}, Time - ${eventMatchDateHour.toISOString()}`);
        return false;
      }
    })

    const sportspageEvent = sportspageData.results.find((event: SportspageResult) => {
      const eventHomeTeam = standardizeTeamName(event.teams.home.team, jsonoddsEvent.Sport)
      const eventAwayTeam = standardizeTeamName(event.teams.away.team, jsonoddsEvent.Sport)
      const eventDateTime = new Date(event.schedule.date)
      const eventMatchDateHour = new Date(
        eventDateTime.getUTCFullYear(),
        eventDateTime.getUTCMonth(),
        eventDateTime.getUTCDate(),
        eventDateTime.getUTCHours()
      )

      // console.log(`Sportspage Event: ${event.gameId}`)
      // console.log(`Sportspage Team Names: Home - ${event.teams.home.team}, Away - ${event.teams.away.team}`)
      // console.log(`Sportspage Match Time: ${new Date(event.schedule.date).toISOString()}`)

      if (eventHomeTeam === jsonoddsHomeTeam && eventAwayTeam === jsonoddsAwayTeam && eventMatchDateHour.getTime() === jsonoddsMatchDateHour.getTime()) {
        // console.log(`Match found for JsonOdds event ${jsonoddsEvent.ID}: Sportspage event ${event.gameId}`);
        return true;
      } else {
        // console.log(`Comparing JsonOdds event ${jsonoddsEvent.ID} with Sportspage event ${event.gameId}`);
        // console.log(`JsonOdds: Home - ${jsonoddsHomeTeam}, Away - ${jsonoddsAwayTeam}, Time - ${jsonoddsMatchDateHour.toISOString()}`);
        // console.log(`Sportspage: Home - ${eventHomeTeam}, Away - ${eventAwayTeam}, Time - ${eventMatchDateHour.toISOString()}`);
        return false;
      }

    })

    if (rundownEvent && sportspageEvent) {
      // console.log('Found matching event:', jsonoddsEvent.ID)
      const existingEvent = existingContests.find(e => e.jsonoddsID === jsonoddsEvent.ID)
      const isCreated = existingEvent ? existingEvent.Created : false
      // Derive final state and scores, preferring Rundown
      const rScore = rundownEvent.score as RundownScore | undefined
      const sportStatusRaw = String((sportspageEvent as any)?.status || '').toLowerCase()
      const eventStatusRaw = String(rScore?.event_status || '').toLowerCase()
      const eventStatusDetailRaw = String(rScore?.event_status_detail || '').toLowerCase()
      const displayClockRaw = String(rScore?.display_clock || '').toLowerCase()
      const isFinalByRundown =
        eventStatusRaw.includes('final') ||
        eventStatusDetailRaw.includes('final') ||
        displayClockRaw === 'final'
      const isFinalBySportspage =
        sportStatusRaw.includes('final') ||
        sportStatusRaw.includes('complete') ||
        sportStatusRaw.includes('finished')
      const isFinal = Boolean(isFinalByRundown || isFinalBySportspage)
      // Scores (Rundown provides numeric scores)
      const awayScoreVal = typeof rScore?.score_away === 'number' ? rScore!.score_away : undefined
      const homeScoreVal = typeof rScore?.score_home === 'number' ? rScore!.score_home : undefined
      // Scored timestamp (prefer Rundown updated_at if present)
      const scoredAtTs = (() => {
        try {
          const u = rScore?.updated_at
          if (isFinal && u) {
            const d = new Date(u)
            if (Number.isFinite(d.getTime())) return admin.firestore.Timestamp.fromDate(d)
          }
        } catch {}
        return isFinal ? admin.firestore.Timestamp.now() : undefined
      })()

      return {
        jsonoddsID: jsonoddsEvent.ID,
        rundownID: rundownEvent.event_id,
        sportspageID: sportspageEvent.gameId,
        Sport: jsonoddsEvent.Sport,
        AwayTeam: jsonoddsEvent.AwayTeam,
        HomeTeam: jsonoddsEvent.HomeTeam,
        MatchTime: admin.firestore.Timestamp.fromDate(new Date(`${jsonoddsEvent.MatchTime}Z`)),
        OddType: jsonoddsEvent.Odds[0].OddType,
        // Store comprehensive odds data from JsonOdds for leaderboard validation and odds updates
        MoneyLineAway: jsonoddsEvent.Odds[0].MoneyLineAway,
        MoneyLineHome: jsonoddsEvent.Odds[0].MoneyLineHome,
        OverLine: jsonoddsEvent.Odds[0].OverLine,
        TotalNumber: jsonoddsEvent.Odds[0].TotalNumber,
        UnderLine: jsonoddsEvent.Odds[0].UnderLine,
        PointSpreadAway: jsonoddsEvent.Odds[0].PointSpreadAway,
        PointSpreadHome: jsonoddsEvent.Odds[0].PointSpreadHome,
        PointSpreadAwayLine: jsonoddsEvent.Odds[0].PointSpreadAwayLine,
        PointSpreadHomeLine: jsonoddsEvent.Odds[0].PointSpreadHomeLine,
        HomePitcher: jsonoddsEvent.HomePitcher || undefined,
        AwayPitcher: jsonoddsEvent.AwayPitcher || undefined,
        HomeROT: jsonoddsEvent.HomeROT || undefined,
        AwayROT: jsonoddsEvent.AwayROT || undefined,
        LastUpdated: admin.firestore.Timestamp.now(),
        Created: isCreated,
        // Status remains "Ready" until final to minimize downstream changes; mark Final when detected
        status: isFinal ? 'Final' : 'Ready',
        // Final/score fields (optional; only set when available)
        ...(awayScoreVal != null ? { awayScore: awayScoreVal } : {}),
        ...(homeScoreVal != null ? { homeScore: homeScoreVal } : {}),
        isFinal: Boolean(isFinal),
        ...(scoredAtTs ? { scoredAt: scoredAtTs } : {}),
        ...(rScore?.event_status ? { eventStatus: rScore.event_status } : {}),
        ...(rScore?.event_status_detail ? { eventStatusDetail: rScore.event_status_detail } : {}),
        ...(sportspageEvent.status ? { sportspageStatus: sportspageEvent.status } : {}),
      }
    } else {
      // Log potential team name mismatches: find same-hour candidates that failed on name
      const sameHourRundown = rundownData.events.filter((event: RundownEvent) => {
        if (!event.teams || event.teams.length < 2) return false
        const eventDateTime = new Date(event.event_date)
        const eventMatchDateHour = new Date(
          eventDateTime.getUTCFullYear(),
          eventDateTime.getUTCMonth(),
          eventDateTime.getUTCDate(),
          eventDateTime.getUTCHours()
        )
        return eventMatchDateHour.getTime() === jsonoddsMatchDateHour.getTime()
      })
      const sameHourSportspage = sportspageData.results.filter((event: SportspageResult) => {
        const eventDateTime = new Date(event.schedule.date)
        const eventMatchDateHour = new Date(
          eventDateTime.getUTCFullYear(),
          eventDateTime.getUTCMonth(),
          eventDateTime.getUTCDate(),
          eventDateTime.getUTCHours()
        )
        return eventMatchDateHour.getTime() === jsonoddsMatchDateHour.getTime()
      })

      if (sameHourRundown.length > 0 || sameHourSportspage.length > 0) {
        const missingSource = !rundownEvent && !sportspageEvent ? 'both' : !rundownEvent ? 'Rundown' : 'Sportspage'
        const rundownNames = sameHourRundown.map(e => {
          const home = getTeamNameForSport(jsonoddsEvent.Sport, e.teams_normalized[1].name, e.teams_normalized[1].mascot)
          const away = getTeamNameForSport(jsonoddsEvent.Sport, e.teams_normalized[0].name, e.teams_normalized[0].mascot)
          return `${away} @ ${home}`
        })
        const sportspageNames = sameHourSportspage.map(e => {
          const home = standardizeTeamName(e.teams.home.team, jsonoddsEvent.Sport)
          const away = standardizeTeamName(e.teams.away.team, jsonoddsEvent.Sport)
          return `${away} @ ${home}`
        })
        console.log(
          `[UNMATCHED] JSONOdds ${jsonoddsEvent.ID}: ${jsonoddsAwayTeam} @ ${jsonoddsHomeTeam} ` +
          `(${jsonoddsMatchDateTime.toISOString()}) | No match in: ${missingSource} | ` +
          `Rundown same-hour: [${rundownNames.join(', ')}] | Sportspage same-hour: [${sportspageNames.join(', ')}]`
        )
      }

      return undefined
    }
  }).filter((event): event is CombinedEvent => event !== undefined)
}

/**
 * Update existing contests to mark finals even when JsonOdds drops the game.
 * Matches by stored Rundown/Sportspage IDs and derives final + scores from those feeds.
 */
const updateExistingContestsFinals = async (
  existingContests: CombinedEvent[],
  rundownData: RundownResponse,
  sportspageData: SportspageResponse,
): Promise<void> => {
  try {
    const byRundownId = new Map<string, RundownEvent>()
    for (const ev of rundownData.events || []) {
      if (ev?.event_id) byRundownId.set(String(ev.event_id), ev)
    }
    const bySportspageId = new Map<number, SportspageResult>()
    for (const ev of (sportspageData?.results || [])) {
      if (typeof ev?.gameId === 'number') bySportspageId.set(ev.gameId, ev)
    }
    const batch = db.batch()
    let updates = 0
    for (const item of existingContests) {
      if (item?.isFinal) continue
      const r = item?.rundownID ? byRundownId.get(String(item.rundownID)) : undefined
      const s = (item as any)?.sportspageID != null ? bySportspageId.get(Number((item as any).sportspageID)) : undefined
      if (!r && !s) continue
      const rScore = (r as any)?.score as RundownScore | undefined
      const sportStatusRaw = String((s as any)?.status || '').toLowerCase()
      const eventStatusRaw = String(rScore?.event_status || '').toLowerCase()
      const eventStatusDetailRaw = String(rScore?.event_status_detail || '').toLowerCase()
      const displayClockRaw = String(rScore?.display_clock || '').toLowerCase()
      const isFinalByRundown =
        eventStatusRaw.includes('final') ||
        eventStatusDetailRaw.includes('final') ||
        displayClockRaw === 'final'
      const isFinalBySportspage =
        sportStatusRaw.includes('final') ||
        sportStatusRaw.includes('complete') ||
        sportStatusRaw.includes('finished')
      const isFinal = Boolean(isFinalByRundown || isFinalBySportspage)
      if (!isFinal) continue
      const awayScoreVal = typeof rScore?.score_away === 'number' ? rScore!.score_away : undefined
      const homeScoreVal = typeof rScore?.score_home === 'number' ? rScore!.score_home : undefined
      const scoredAtTs = (() => {
        try {
          const u = rScore?.updated_at
          if (u) {
            const d = new Date(u)
            if (Number.isFinite(d.getTime())) return admin.firestore.Timestamp.fromDate(d)
          }
        } catch {}
        return admin.firestore.Timestamp.now()
      })()
      const ref = db.collection('contests').doc(String(item.jsonoddsID))
      const update: Partial<CombinedEvent> & {
        status: string; isFinal: boolean;
      } = {
        status: 'Final',
        isFinal: true,
        ...(awayScoreVal != null ? { awayScore: awayScoreVal } : {}),
        ...(homeScoreVal != null ? { homeScore: homeScoreVal } : {}),
        scoredAt: scoredAtTs,
        ...(rScore?.event_status ? { eventStatus: rScore.event_status } : {}),
        ...(rScore?.event_status_detail ? { eventStatusDetail: rScore.event_status_detail } : {}),
        ...(s?.status ? { sportspageStatus: s.status } : {}),
        LastUpdated: admin.firestore.Timestamp.now(),
      }
      batch.set(ref, update, { merge: true })
      updates++
    }
    if (updates > 0) {
      await batch.commit()
      console.log(`Updated ${updates} existing contests to Final`)
    }
  } catch (error) {
    console.error('Error updating existing finals:', error)
  }
}

const fetchRundownData = async (sportId: number, dates: string[]): Promise<RundownResponse | undefined> => {
  try {
    // console.log(`Fetching Rundown data for Sport ID: ${sportId} and Dates: ${dates}`) // API call initiation log
    let allEvents: RundownEvent[] = []
    for (const date of dates) {
      // console.log(`Making Rundown API call for date: ${date}`)
      const response = await axios.get(`https://therundown-therundown-v1.p.rapidapi.com/sports/${sportId}/events/${date}`, {
        headers: {
          'x-rapidapi-host': 'therundown-therundown-v1.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPIDAPI_API_KEY
        }
      })
      // console.log(`Rundown API response for date ${date}:`, response.data) // API response log
      allEvents = allEvents.concat(response.data.events)
    }
    // console.log(`Total Rundown events fetched: ${allEvents.length}`) // General info log
    return {
      meta: { delta_last_id: '' },
      events: allEvents
    }
  } catch (error) {
    console.error('Error fetching Rundown data:', error)
    return { meta: { delta_last_id: '' }, events: [] } // Return an empty array in case of error
  }
}

const fetchSportspageData = async (league: string, dates: string[]): Promise<SportspageResponse | undefined> => {
  try {
    // console.log(`Fetching Sportspage data for League: ${league} and Dates: ${dates}`)
    let allResults: SportspageResult[] = []
    for (const date of dates) {
      // console.log(`Making Sportspage API call for date: ${date}`)
      
      // Pagination: Sportspage returns max 100 games per call
      // If games === 100, there may be more - keep fetching with skip parameter
      let skip = 0
      let hasMoreResults = true
      
      while (hasMoreResults) {
        const url = skip === 0
          ? `https://sportspage-feeds.p.rapidapi.com/games?date=${date}&league=${league}`
          : `https://sportspage-feeds.p.rapidapi.com/games?date=${date}&league=${league}&skip=${skip}`
        
        // console.log(`Making Sportspage API call: ${url}`)
        const response = await axios.get(url, {
          headers: {
            'x-rapidapi-host': 'sportspage-feeds.p.rapidapi.com',
            'x-rapidapi-key': process.env.RAPIDAPI_API_KEY
          }
        })
        
        const results = response.data.results || []
        const gamesReturned = response.data.games || results.length
        
        // console.log(`Sportspage API response for date ${date} (skip=${skip}): ${gamesReturned} games`)
        allResults = allResults.concat(results)
        
        // If we got exactly 100 games, there might be more - fetch next page
        if (gamesReturned === 100) {
          skip += 100
          console.log(`Sportspage returned 100 games for ${league} on ${date}, fetching more with skip=${skip}`)
        } else {
          // Less than 100 means we've got all results for this date
          hasMoreResults = false
        }
      }
    }
    console.log(`Total Sportspage results fetched for ${league}: ${allResults.length}`)
    return {
      status: 200,
      time: new Date().toISOString(),
      games: allResults.length,
      skip: 0,
      results: allResults
    }
  } catch (error) {
    console.error('Error fetching Sportspage data:', error)
    return {
      status: 500,
      time: new Date().toISOString(),
      games: 0,
      skip: 0,
      results: []
    }
  }
}

const fetchJsonoddsData = async (): Promise<JsonoddsResponse[] | undefined> => {
  try {
    console.log('Fetching JsonOdds data')
    const response = await axios.get('https://jsonodds.com/api/odds?oddType=Game', {
      headers: {
        'x-api-key': process.env.JSONODDS_API_KEY
      }
    })
    console.log('JsonOdds response count:', response.data.length)
    console.log('NCAAF games:', response.data.filter((game: JsonoddsResponse) => game.Sport === 3).length)
    return response.data
  } catch (error) {
    console.error('Error fetching Jsonodds data:', error)
  }
}

const archiveOldData = async () => {
  try {
    const contestsColRef = db.collection('contests')
    const contestsSnapshot = await contestsColRef.get()

    const archiveColRef = db.collection('contests_archive')

    const batch = db.batch()
    const nowMs = Date.now()
    const hours = Number(process.env.ARCHIVE_AFTER_HOURS || '48')
    const ttlMs = Math.max(1, hours) * 3600 * 1000

    // Move only truly finished contests (Final and older than threshold)
    contestsSnapshot.forEach(docSnapshot => {
      const data = docSnapshot.data() as any
      const isFinal = Boolean(data?.isFinal || (String(data?.status || '').toLowerCase() === 'final'))
      if (!isFinal) return
      const when =
        (data?.scoredAt && typeof data.scoredAt?.toDate === 'function'
          ? (data.scoredAt as admin.firestore.Timestamp).toDate().getTime()
          : undefined) ??
        (data?.MatchTime && typeof data.MatchTime?.toDate === 'function'
          ? (data.MatchTime as admin.firestore.Timestamp).toDate().getTime()
          : undefined)
      const ageMs = when ? (nowMs - when) : Number.POSITIVE_INFINITY
      if (ageMs < ttlMs) return
      const archiveDocRef = archiveColRef.doc(docSnapshot.id)
      const archiveData = { ...data, movedDate: admin.firestore.Timestamp.now() }
      batch.set(archiveDocRef, archiveData)
      batch.delete(contestsColRef.doc(docSnapshot.id))
    })
    await batch.commit()
    console.log('Archiving pass complete')
  } catch (error) {
    console.error('Error archiving old data:', error)
  }
}

const saveDataToFirestore = async (data: CombinedEvent[]): Promise<void> => {
  try {
    const batch = db.batch()
    const colRef = db.collection('contests')
    data.forEach(item => {
      const docRef = colRef.doc(item.jsonoddsID)
      batch.set(docRef, item, { merge: true })
    })
    await batch.commit()
    console.log('Data successfully saved to Firestore')
  } catch (error) {
    console.error('Error saving data to Firestore:', error)
  }
}

const monitor = async () => {
  try {
    const jsonoddsData = await fetchJsonoddsData()
    if (!jsonoddsData) {
      throw new Error('JsonOdds API request failed');
    }
    console.log('JsonOdds data count:', jsonoddsData.length)

    let allCombinedData: CombinedEvent[] = []
    const allRundownEvents: RundownEvent[] = []
    const allSportspageResults: SportspageResult[] = []
    const existingContests = await fetchExistingContestsFromFirestore()
    console.log('Existing contests:', existingContests.length)

    for (const sport of Object.keys(sportsConfig)) {
      console.log(`Processing sport: ${sport}`)
      if (isSeasonActive(sport as keyof typeof sportsConfig)) {
        console.log(`${sport} is active`)
        const { phase, daysAhead } = getSeasonPhaseAndDaysAhead(sport as keyof typeof sportsConfig)
        console.log(`Phase: ${phase}, Days ahead: ${daysAhead}`)
        
        const dates = getDatesForNextNDays(daysAhead)

        // Fetch sports data for these dates
        const rundownData = await fetchRundownData(sportsConfig[sport as keyof typeof sportsConfig].rundownId, dates)
        const sportspageData = await fetchSportspageData(sport, dates)

        console.log(`Rundown events: ${rundownData?.events.length || 0}`)
        console.log(`Sportspage results: ${sportspageData?.results.length || 0}`)

        if (rundownData && rundownData.events.length > 0 && sportspageData && sportspageData.results.length > 0) {
          const jsonoddsFilteredData = jsonoddsData.filter(event => event.Sport === sportsConfig[sport as keyof typeof sportsConfig].jsonoddsId)
          const combinedData = processEventData(jsonoddsFilteredData, rundownData, sportspageData, existingContests)
          const validCombinedData = combinedData.filter((event): event is CombinedEvent => event !== undefined)
          console.log('Number of matched events for', sport, ':', (validCombinedData).length)
          allCombinedData = allCombinedData.concat(validCombinedData)
          allRundownEvents.push(...(rundownData.events || []))
          allSportspageResults.push(...(sportspageData.results || []))
        }
      }
    }

    console.log('Total number of matched events across all sports:', allCombinedData.length)
    // console.log(allCombinedData)

    // First, update existing docs to Final using Rundown/Sportspage signals (covers games dropped by JsonOdds)
    await updateExistingContestsFinals(
      existingContests,
      { meta: { delta_last_id: '' }, events: allRundownEvents },
      { status: 200, time: new Date().toISOString(), games: allSportspageResults.length, skip: 0, results: allSportspageResults }
    )
    // Upsert latest feed data (merging fields)
    await saveDataToFirestore(allCombinedData)

    // Save odds history to Supabase (for Michelle's line movement analysis)
    // Build Sportspage results map for opener lookup
    const sportspageResultsMap = new Map<number, SportspageResult>()
    allSportspageResults.forEach(result => {
      sportspageResultsMap.set(result.gameId, result)
    })

    try {
      await saveOddsToSupabase(allCombinedData, sportspageResultsMap)
    } catch (error) {
      console.error('[OddsHistory] Error saving odds to Supabase:', error)
      // Non-blocking - don't fail monitor if Supabase write fails
    }

    // Save games to evaluation slate for agent orchestrator
    try {
      await saveSlateToSupabase(allCombinedData, sportspageResultsMap)
    } catch (error) {
      console.error('[SlateSync] Error saving slate to Supabase:', error)
      // Non-blocking - don't fail monitor if Supabase write fails
    }

    // Archive only truly finished and aged-out contests
    await archiveOldData()

  } catch (error) {
    console.error('Error in matching and storing data:', error)
  }
}

// Scheduling the monitor function to run based on refresh rate in seconds
schedule.scheduleJob(`*/${process.env.REFRESH_RATE} * * * *`, async () => {
  console.log('Running monitor function...')
  await monitor()
})

export { monitor }