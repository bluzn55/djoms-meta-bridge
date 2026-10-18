import { authorize, endpoint, only, AppError } from './core.js';

// Fixed, user-supplied export. No Radio.co credentials or live connection.
const SOURCE = {
  "version": "2026-10-05.radio-import.1",
  "mode": "imported",
  "automaticSync": false,
  "station": "KJAK 24.7",
  "sourceFile": "overview-2026-09-28-12-00-00-2026-10-05-11-59-59.csv",
  "sourceSha256": "3d4dee8cc58ad22156c5b1457eae8b46db12e9515abc8117ebff0619f6172d53",
  "importedAt": "2026-10-05T13:05:39.371698Z",
  "timezone": "UTC",
  "durationUnit": "unverified",
  "rows": [
    {"date":"2026-09-28","connections":0,"dailyUnique":0,"peak":0,"ttslRaw":0,"averageDurationRaw":0,"bandwidthRaw":0,"countries":{"US":0},"devices":{"Smartphone":0,"Desktop":0},"clients":{"Nokia OSS Browser":0,"Mobile Safari":0,"Microsoft Edge":0,"Headless Chrome":0,"Chrome":0},"coverage":"boundary-unverified"},
    {"date":"2026-09-29","connections":5,"dailyUnique":4,"peak":2,"ttslRaw":1338,"averageDurationRaw":267.7216,"bandwidthRaw":171341.824,"countries":{"US":5},"devices":{"Smartphone":1,"Desktop":4},"clients":{"Nokia OSS Browser":1,"Mobile Safari":0,"Microsoft Edge":1,"Headless Chrome":3,"Chrome":0},"coverage":"daily-row"},
    {"date":"2026-09-30","connections":6,"dailyUnique":2,"peak":1,"ttslRaw":9368,"averageDurationRaw":1561.3333333333,"bandwidthRaw":1199104,"countries":{"US":6},"devices":{"Smartphone":0,"Desktop":6},"clients":{"Nokia OSS Browser":0,"Mobile Safari":0,"Microsoft Edge":0,"Headless Chrome":0,"Chrome":6},"coverage":"daily-row"},
    {"date":"2026-10-01","connections":3,"dailyUnique":2,"peak":1,"ttslRaw":911,"averageDurationRaw":303.66666666667,"bandwidthRaw":116608,"countries":{"US":3},"devices":{"Smartphone":1,"Desktop":2},"clients":{"Nokia OSS Browser":0,"Mobile Safari":1,"Microsoft Edge":0,"Headless Chrome":0,"Chrome":2},"coverage":"daily-row"},
    {"date":"2026-10-02","connections":0,"dailyUnique":0,"peak":0,"ttslRaw":0,"averageDurationRaw":0,"bandwidthRaw":0,"countries":{"US":0},"devices":{"Smartphone":0,"Desktop":0},"clients":{"Nokia OSS Browser":0,"Mobile Safari":0,"Microsoft Edge":0,"Headless Chrome":0,"Chrome":0},"coverage":"daily-row"},
    {"date":"2026-10-03","connections":1,"dailyUnique":1,"peak":1,"ttslRaw":2421,"averageDurationRaw":2421,"bandwidthRaw":309888,"countries":{"US":1},"devices":{"Smartphone":0,"Desktop":1},"clients":{"Nokia OSS Browser":0,"Mobile Safari":0,"Microsoft Edge":0,"Headless Chrome":0,"Chrome":1},"coverage":"daily-row"},
    {"date":"2026-10-04","connections":3,"dailyUnique":3,"peak":1,"ttslRaw":43,"averageDurationRaw":14.333333333333,"bandwidthRaw":5504,"countries":{"US":3},"devices":{"Smartphone":0,"Desktop":3},"clients":{"Nokia OSS Browser":0,"Mobile Safari":0,"Microsoft Edge":0,"Headless Chrome":3,"Chrome":0},"coverage":"daily-row"},
    {"date":"2026-10-05","connections":0,"dailyUnique":0,"peak":0,"ttslRaw":0,"averageDurationRaw":0,"bandwidthRaw":0,"countries":{"US":0},"devices":{"Smartphone":0,"Desktop":0},"clients":{"Nokia OSS Browser":0,"Mobile Safari":0,"Microsoft Edge":0,"Headless Chrome":0,"Chrome":0},"coverage":"partial"}
  ]
};


/*
 * Radio.co Overview CSV exported 2026-10-18 for the 7-day window.
 * The per-day epoch fields are UTC midnights (per Radio.co documentation).
 * Never add unique listeners across days and label that result "period unique".
 * CSV daily totals (36) do not match the contemporaneous Overview screen (38).
 * Keep the raw export provenance and show that discrepancy explicitly.
 */
const LATEST_SOURCE = {
  version: '2026-10-18.radio-import.1',
  mode: 'imported',
  automaticSync: false,
  station: 'Outlaw Radio 5150',
  sourceFile: 'overview-2026-10-11-03-42-33-2026-10-18-03-42-33.csv',
  sourceSha256: '132204c6d619ce5fb26e0be0c3f4cbe04950ab08e20361062162111469e2c064',
  importedOn: '2026-10-18',
  timezone: 'UTC',
  durationUnit: 'seconds',
  periodUniqueScope: 'unverified',
  rows: [
    {date:'2026-10-12',connections:8,dailyUnique:1,peak:2,ttslRaw:1049,averageDurationRaw:131.125,bandwidthRaw:134272,countries:{US:8},devices:{Smartphone:0,Desktop:8},clients:{'Mobile Safari':0,'Microsoft Edge':0,'Headless Chrome':0,Chrome:8},coverage:'daily-row'},
    {date:'2026-10-13',connections:0,dailyUnique:0,peak:0,ttslRaw:0,averageDurationRaw:0,bandwidthRaw:0,countries:{US:0},devices:{Smartphone:0,Desktop:0},clients:{'Mobile Safari':0,'Microsoft Edge':0,'Headless Chrome':0,Chrome:0},coverage:'daily-row'},
    {date:'2026-10-14',connections:5,dailyUnique:1,peak:1,ttslRaw:740,averageDurationRaw:148,bandwidthRaw:94720,countries:{US:5},devices:{Smartphone:0,Desktop:5},clients:{'Mobile Safari':0,'Microsoft Edge':0,'Headless Chrome':0,Chrome:5},coverage:'daily-row'},
    {date:'2026-10-15',connections:20,dailyUnique:1,peak:2,ttslRaw:1864,averageDurationRaw:93.2,bandwidthRaw:238592,countries:{US:20},devices:{Smartphone:0,Desktop:20},clients:{'Mobile Safari':0,'Microsoft Edge':0,'Headless Chrome':0,Chrome:20},coverage:'daily-row'},
    {date:'2026-10-16',connections:1,dailyUnique:1,peak:1,ttslRaw:71,averageDurationRaw:71,bandwidthRaw:9088,countries:{US:1},devices:{Smartphone:0,Desktop:1},clients:{'Mobile Safari':0,'Microsoft Edge':0,'Headless Chrome':1,Chrome:0},coverage:'daily-row'},
    {date:'2026-10-17',connections:2,dailyUnique:2,peak:1,ttslRaw:26,averageDurationRaw:13,bandwidthRaw:3328,countries:{US:2},devices:{Smartphone:1,Desktop:1},clients:{'Mobile Safari':1,'Microsoft Edge':1,'Headless Chrome':0,Chrome:0},coverage:'daily-row'},
    {date:'2026-10-18',connections:0,dailyUnique:0,peak:0,ttslRaw:0,averageDurationRaw:0,bandwidthRaw:0,countries:{US:0},devices:{Smartphone:0,Desktop:0},clients:{'Mobile Safari':0,'Microsoft Edge':0,'Headless Chrome':0,Chrome:0},coverage:'partial'}
  ],
  screenComparison: {
    screenConnections: 38,
    screenPeriodUnique: 6,
    screenPeak: 2,
    screenAverageDurationSeconds: 91,
    note: 'Radio.co Overview screen reported 38 connections and 1m31s average; downloaded daily CSV totals are 36 connections and 1m44s average. Values are not reconciled.'
  }
};

function summarizeRadioSource(source) {
  const rows = source.rows;
  const sum = key => rows.reduce((n, r) => n + r[key], 0);
  const combine = key => rows.reduce((out, row) => {
    for (const [name, value] of Object.entries(row[key])) out[name] = (out[name] || 0) + value;
    return out;
  }, {});
  const connections = sum('connections');
  const maximum = Math.max(0, ...rows.map(r => r.connections));
  const peak = Math.max(0, ...rows.map(r => r.peak));
  const totalDurationRaw = sum('ttslRaw');
  return {
    ...source,
    range: { start: rows[0].date, end: rows.at(-1).date, bucket: 'day', timezone: source.timezone },
    summary: {
      connections,
      peak,
      periodUnique: null,
      dailyUniqueSum: sum('dailyUnique'),
      busiestDates: maximum > 0 ? rows.filter(r => r.connections === maximum).map(r => r.date) : [],
      busiestConnections: maximum,
      peakDates: peak > 0 ? rows.filter(r => r.peak === peak).map(r => r.date) : [],
      totalDurationRaw,
      averageDurationRaw: connections ? totalDurationRaw / connections : null,
      countries: combine('countries'), devices: combine('devices'), clients: combine('clients')
    }
  };
}

export function buildRadioReport() {
  return {
    ...summarizeRadioSource(LATEST_SOURCE),
    archivedImports: [summarizeRadioSource(SOURCE)],
    notes: [
      'Historical CSV import. Not a live Radio.co connection.',
      'Daily unique listeners cannot safely be summed into a period-unique count.',
      'Radio.co reports multi-day periods in UTC, not the station timezone.',
      'Listen counts are streaming connections, not individual people.'
    ]
  };
}

export const radioReportEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  await authorize(req);
  return res.json(buildRadioReport());
});

/*
 * Official Radio.co PUBLIC status endpoint.
 * This is broadcast status and now-playing metadata, never a listener count.
 * The public status endpoint does not document listener statistics.
 * A fixed station ID prevents a user-provided URL from entering server fetch().
 */
const PUBLIC_STATION = 's37e227d75';
export const radioLiveStatusEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  await authorize(req);
  let response;
  try {
    response = await fetch('https://public.radio.co/stations/' + PUBLIC_STATION + '/status', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new AppError('Radio.co station status could not be reached. Try refreshing.', 502);
  }
  if (!response.ok) throw new AppError('Radio.co station status is temporarily unavailable.', 502);
  const value = await response.json().catch(() => null);
  const broadcastStatus = value?.status;
  if (broadcastStatus !== 'online' && broadcastStatus !== 'offline') {
    throw new AppError('Radio.co returned an unrecognized station status.', 502);
  }
  const clean = value => typeof value === 'string'
    ? value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 220)
    : null;
  res.json({
    connected: true,
    mode: 'public-station-status',
    station: 'Outlaw Radio 5150',
    stationId: PUBLIC_STATION,
    checkedAt: new Date().toISOString(),
    broadcastStatus,
    nowPlaying: clean(value.current_track?.title) || null,
    sourceType: clean(value.source?.type) || null,
    listenerCount: null,
    listenerCountAvailable: false,
    statisticsConnected: false,
    note: 'Official public broadcast status, not live listener counts or a Radio.co statistics connection.'
  });
});
