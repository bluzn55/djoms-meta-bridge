import { authorize, endpoint, only } from './core.js';

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

export function buildRadioReport() {
  const rows = SOURCE.rows;
  const sum = key => rows.reduce((n, r) => n + r[key], 0);
  const combine = key => rows.reduce((out, row) => {
    for (const [name, value] of Object.entries(row[key])) out[name] = (out[name] || 0) + value;
    return out;
  }, {});
  const connections = sum('connections');
  const maximum = Math.max(0, ...rows.map(r => r.connections));
  const peak = Math.max(0, ...rows.map(r => r.peak));
  return {
    ...SOURCE,
    range: { start: rows[0].date, end: rows.at(-1).date, bucket: 'day' },
    summary: {
      connections, peak, periodUnique: null,
      busiestDates: maximum > 0 ? rows.filter(r => r.connections === maximum).map(r => r.date) : [],
      busiestConnections: maximum,
      peakDates: peak > 0 ? rows.filter(r => r.peak === peak).map(r => r.date) : [],
      totalDurationRaw: sum('ttslRaw'),
      averageDurationRaw: connections ? sum('ttslRaw') / connections : null,
      countries: combine('countries'), devices: combine('devices'), clients: combine('clients')
    }
  };
}

export const radioReportEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  await authorize(req);
  return res.json(buildRadioReport());
});
