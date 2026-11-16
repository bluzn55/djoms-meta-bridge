// Wix Semantic Model Query Data supports offset/limit paging. Its metadata
// reports returned count and requested offset, not a total or a next cursor.
// A short, valid page proves completion; reaching the safety bound does not.
// https://dev.wix.com/docs/api-reference/business-management/analytics/semantic-models/query-semantic-model-data
export const WIX_PAGE_BATCH = 500;
export const WIX_PAGE_LIMIT = 2000;

export async function collectWixPageRows(load, keyFor) {
  const results = [], seen = new Set();
  const incomplete = reason => ({results, complete:false, reason});
  for (let offset=0; offset<WIX_PAGE_LIMIT; offset+=WIX_PAGE_BATCH) {
    let response;
    try { response = await load({limit:WIX_PAGE_BATCH, offset}); }
    catch { return incomplete('Wix could not return every page of this report.'); }
    if (!Array.isArray(response?.results))
      return incomplete('Wix did not return a measured page list.');
    const rows=response.results, meta=response.pagingMetadata;
    if (rows.length>WIX_PAGE_BATCH ||
        (meta?.count!==undefined && meta.count!==rows.length) ||
        (meta?.offset!==undefined && meta.offset!==offset) ||
        (offset>0 && meta?.offset!==offset))
      return incomplete('Wix pagination did not match the requested page.');
    for (const row of rows) {
      const key=keyFor(row);
      // Do not count duplicate pages twice or certify a changing/truncated
      // paging snapshot as a complete site-wide page list.
      if (typeof key!=='string' || !key || seen.has(key))
        return incomplete('Wix returned an unidentifiable or repeated page row.');
      seen.add(key);
      results.push(row);
    }
    if (rows.length<WIX_PAGE_BATCH)
      return {results, complete:true, reason:null};
  }
  return incomplete('The report reached its 2,000-page safety limit; more pages may exist.');
}

export function entryPageCoverage(rows, complete, websiteSessions, note=null) {
  const paths=new Set();
  let landingSessions=0, validRows=Array.isArray(rows)&&(complete===true||rows.length>0);
  for (const row of rows||[]) {
    let path=null;
    try {
      if (typeof row?.path==='string' && /^(?:\/|https?:\/\/)/i.test(row.path)) {
        const url=new URL(row.path,'https://www.docjaks.com');
        if (['http:','https:'].includes(url.protocol) &&
            ['docjaks.com','www.docjaks.com'].includes(url.hostname.toLowerCase()))
          path=url.pathname.replace(/\/$/,'')||'/';
      }
    } catch {}
    if (!path || !Number.isSafeInteger(row?.sessions) || row.sessions<0) {
      validRows=false;
      continue;
    }
    landingSessions+=row.sessions;
    if (row.sessions>0) paths.add(path);
  }
  if (!Number.isSafeInteger(landingSessions)) validRows=false;
  const websiteMeasured=Number.isSafeInteger(websiteSessions)&&websiteSessions>=0;
  const aligned=complete===true && validRows && websiteMeasured &&
    landingSessions===websiteSessions;
  const status=aligned?'reported':complete===true&&validRows?'pending':
    rows?.length?'partial':'unavailable';
  return {
    status,
    count:aligned?paths.size:null,
    reportedDistinctPages:validRows?paths.size:null,
    landingSessions:validRows?landingSessions:null,
    websiteSessions:websiteMeasured?websiteSessions:null,
    note:aligned?'All reported entry pages reconcile to the Wix website session total.':
      status==='pending'?'Wix entry-page sessions and the website session total have not yet reconciled.':
      note||'Wix has not returned a complete measured entry-page list.'
  };
}
