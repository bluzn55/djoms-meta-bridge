// Read-only Trading Post report. Never writes orders, payments or credentials.
import { AppError, authorize, endpoint, only, read, unseal } from './core.js';
import { localDate, shiftDate, midnight } from './website-interests.js';
import { resolveReportWindow } from './report-window.js';
const ORDERS = 'https://www.wixapis.com/ecom/v1/orders/search';
const STORE_APP = '215238eb-22a5-4c36-9e7b-e7c08025e04e';
const CATALOG = 'https://www.wixapis.com/stores/v3/products/query';
// Verified Oct 20 against Doc Jaks Wix Stores V3 catalog root categories.
const ROOTS = {
 food:'4fd7c1e4-356b-47cc-a8fa-56e15683361d',
 swag:'b252b808-f990-459a-af7b-a26eec3ea7f1',
 music:'8d0d5522-fc0d-49f8-a3ad-1e73914408a3',
 books:'db6e6577-853c-4a1d-ae85-29020b4402d9',
 bundles:'35b31541-013f-41e5-934a-249f9083fae2'
};
const GROUPS=[['food','Food'],['swag','Swag'],['music','Music'],
 ['books','Books'],['bundles','Bundles'],['review','Needs Review']];
const integer = n => Number.isSafeInteger(n) && n >= 0;
export function cents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimal = ''] = value.split('.');
  const n = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(n) ? n : null;
}
export function summarizeOrders(orders) {
  const products = new Map(), excluded = { canceled: 0, refundReview: 0, unpaid: 0, nonWebsite: 0, nonStore: 0, needsReview: 0 };
  const review = [];
  let paidOrders = 0, units = 0;
  const reviewedIds = new Set();
  function hold(order, category, reason) {
    excluded[category]++;
    if (review.length < 50) review.push({ orderNumber: String(order.number ?? ''), reason });
  }
  for (const order of orders) {
    if (!order || typeof order.id !== 'string' || reviewedIds.has(order.id)) throw new AppError('Order identifiers could not be reconciled.', 502);
    reviewedIds.add(order.id);
    if (order.channelInfo?.type !== 'WEB') { excluded.nonWebsite++; continue; }
    if (order.status === 'CANCELED' || order.status === 'REJECTED') { hold(order, 'canceled', 'Canceled or rejected'); continue; }
    const balance = order.balanceSummary || {};
    const hasRefund = ['FULLY_REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus)
      || ['refunded', 'pendingRefund', 'chargeback'].some(k => cents(balance[k]?.amount) > 0)
      || (order.lineItems || []).some(line => Number(line.refundQuantity) > 0);
    if (hasRefund) { hold(order, 'refundReview', 'Refund, pending refund or dispute: excluded from paid-sales totals'); continue; }
    if (order.status !== 'APPROVED' || order.paymentStatus !== 'PAID') { hold(order, 'unpaid', 'Not approved and fully paid'); continue; }
    if (!Array.isArray(order.lineItems)) { hold(order, 'needsReview', 'Missing order items'); continue; }
    const lines = order.lineItems.filter(line => line.catalogReference?.appId === STORE_APP);
    if (!lines.length) { excluded.nonStore++; continue; }
    // This version reports USD unit products. Unverified quantities/amounts are held out.
    if (order.currency !== 'USD' || lines.some(line => !integer(line.quantity) || line.quantity < 1 || line.decimalQuantity || !line.productName?.original || !line.catalogReference?.catalogItemId || cents(line.totalPriceBeforeTax?.amount) === null)) {
      hold(order, 'needsReview', 'Currency, quantity or item price needs review'); continue;
    }
    paidOrders++;
    for (const line of lines) {
      const sku = line.physicalProperties?.sku || '';
      const variant = line.catalogReference.options || {};
      const options = JSON.stringify(Object.fromEntries(Object.entries(variant).sort(([a], [b]) => a.localeCompare(b))));
      const key = JSON.stringify([line.catalogReference.catalogItemId, options, sku]);
      let product = products.get(key);
      if (!product) {
        product = { productId: line.catalogReference.catalogItemId, name: line.productName.original, sku, units: 0, itemSalesCents: 0, orders: new Set() };
        products.set(key, product);
      }
      product.units += line.quantity;
      product.itemSalesCents += cents(line.totalPriceBeforeTax.amount);
      product.orders.add(order.id);
      units += line.quantity;
    }
  }
  const rows = [...products.values()].map(p => ({ productId: p.productId, name: p.name, sku: p.sku, units: p.units, orderCount: p.orders.size, itemSalesCents: p.itemSalesCents }));
  rows.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
  const itemSalesCents = rows.reduce((sum, p) => sum + p.itemSalesCents, 0);
  if (![units, itemSalesCents].every(integer)) throw new AppError('Product totals could not be reconciled.', 502);
  return { paidOrders, units, itemSalesCents, products: rows, excluded, review, sourceOrderCount: orders.length, currency: 'USD' };
}

export function onlineProductCategory(product){
  if(!product||typeof product!=='object')return 'review';
  const ids=new Set([product.mainCategoryId,
    ...(Array.isArray(product.directCategoriesInfo?.categories)?
      product.directCategoriesInfo.categories.map(v=>v?.id):[]),
    ...(Array.isArray(product.allCategoriesInfo?.categories)?
      product.allCategoriesInfo.categories.map(v=>v?.id):[])
  ].filter(Boolean));
  const hit=['food','swag','music','books'].filter(k=>ids.has(ROOTS[k]));
  if(ids.has(ROOTS.bundles)||hit.length>1)return 'bundles';
  return hit[0]||'review';
}
export function groupOnlineItemSales(report,catalogProducts=[],complete=true){
  const items=Array.isArray(report?.products)?report.products:[];
  const catalog=new Map(catalogProducts.filter(p=>p&&typeof p.id==='string').map(p=>[p.id,p]));
  const groups=GROUPS.map(([id,label])=>({id,label,itemSalesCents:0,units:0,products:[]}));
  const byId=new Map(groups.map(g=>[g.id,g]));
  let unmatched=0;
  for(const p of items){
    const meta=catalog.get(p?.productId);
    if(!meta)unmatched++;
    const group=byId.get(onlineProductCategory(meta));
    if(!group||!integer(p?.units)||!integer(p?.itemSalesCents))
      throw new AppError('Purchased item could not be classified.',502);
    group.itemSalesCents+=p.itemSalesCents;group.units+=p.units;
    group.products.push({productId:String(p.productId||''),
      name:String(p.name||'').slice(0,160),sku:String(p.sku||'').slice(0,70),
      units:p.units,orders:integer(p.orderCount)?p.orderCount:null,
      itemSalesCents:p.itemSalesCents});
  }
  const centsTotal=groups.reduce((n,g)=>n+g.itemSalesCents,0);
  const unitTotal=groups.reduce((n,g)=>n+g.units,0);
  if(!integer(centsTotal)||centsTotal!==report?.itemSalesCents||unitTotal!==report?.units)
    throw new AppError('Category totals do not reconcile with verified Wix sales.',502);
  groups.forEach(g=>g.products.sort((a,b)=>b.itemSalesCents-a.itemSalesCents||a.name.localeCompare(b.name)));
  return {status:complete&&unmatched===0?'reported':'partial',groups,
    itemSalesCents:centsTotal,units:unitTotal,unclassifiedProducts:unmatched,
    note:unmatched?
      'Some products could not be matched to the Wix catalog. Needs Review is not an assumed category.':
      'Each paid item is counted once under its actual Wix Stores V3 product category.'};
}
async function categorizePaidItems(report,request){
  if(!report?.complete||!Array.isArray(report.products))return null;
  if(!report.products.length)return groupOnlineItemSales(report,[],true);
  const ids=[...new Set(report.products.map(p=>String(p.productId||'')).filter(Boolean))];
  const catalog=[];
  try{
    for(let i=0;i<ids.length;i+=100){
      const batch=ids.slice(i,i+100),seen=new Set();
      let cursor=null,complete=false;
      for(let page=0;page<5;page++){
        const result=await request(CATALOG,{
          fields:['DIRECT_CATEGORIES_INFO','ALL_CATEGORIES_INFO'],
          query:{filter:{id:{$in:batch}},cursorPaging:{limit:100,...(cursor?{cursor}:{})}}
        });
        if(!Array.isArray(result.products))throw Error('No catalog product list.');
        catalog.push(...result.products);
        if(result.pagingMetadata?.hasNext===false){complete=true;break;}
        const next=result.pagingMetadata?.cursors?.next;
        if(!next||seen.has(next))break;
        seen.add(next);cursor=next;
      }
      if(!complete)throw Error('Catalog query incomplete.');
    }
    return groupOnlineItemSales(report,catalog,true);
  }catch{
    // Product metadata cannot invalidate the paid-orders report.
    return {...groupOnlineItemSales(report,[],false),status:'unavailable',
      note:'Catalog access is unavailable. Verified paid items are in Needs Review until categorized.'};
  }
}
export async function buildSalesReport(request, days, today, selectedWindow=null) {
  const start = selectedWindow?.start || shiftDate(today, -(days - 1)), end = selectedWindow?.end || shiftDate(today, 1);
  const from = midnight(start), until = midnight(end);
  const orders = [], cursors = new Set();
  let cursor, complete = false;
  for (let page = 0; page < 20; page++) {
    const data = await request(ORDERS, { search: { filter: { $and: [{ createdDate: { $gte: from } }, { createdDate: { $lt: until } }], status: { $in: ['APPROVED', 'CANCELED', 'PENDING', 'REJECTED'] } }, cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) } } });
    if (!Array.isArray(data.orders)) throw new AppError('Wix did not return an order list.', 502);
    for (const order of data.orders) {
      const created = Date.parse(order.createdDate);
      if (!Number.isFinite(created) || created < Date.parse(from) || created >= Date.parse(until)) throw new AppError('Order dates did not match this report.', 502);
    }
    orders.push(...data.orders);
    if (data.metadata?.hasNext === false) { complete = true; break; }
    const next = data.metadata?.cursors?.next;
    if (!next || cursors.has(next)) break;
    cursors.add(next); cursor = next;
  }
  if (!complete) throw new AppError('The order report was incomplete. Totals are not being guessed.', 503);
  return { version: '2026-10-05.trading.1', connected: true, complete, checkedAt: new Date().toISOString(), range: { start, end, days: selectedWindow?.days||days, selection:selectedWindow?.range||(days===28?'28d':'7d'), timezone: 'America/Chicago' }, ...summarizeOrders(orders), method: 'Orders created in the selected period. Approved and PAID website orders only. Refunds, pending refunds, disputes, canceled and unpaid orders excluded and summarized separately. Item amounts before tax; shipping excluded. Bundles count as one purchased unit. No inference that the buyer entered through the Trading Post page.' };
}
async function load(days, today, selectedWindow=null) {
  const saved = await read('wix-blog-connection');
  if (!saved?.sealed) throw new AppError('Connect Wix website data first.', 409);
  const c = unseal(saved.sealed);
  if (!c.clientId || !c.clientSecret) throw new AppError('The Wix connection needs attention.', 409);
  const signal = AbortSignal.timeout(35000);
  const tr = await fetch('https://www.wixapis.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }), signal });
  const token = await tr.json();
  if (!tr.ok || !token.access_token) throw new AppError('Wix authorization needs attention.', 409);
  const request = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: token.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if ([401, 403].includes(response.status)) throw new AppError('The saved Wix connection needs Read Orders access. Website traffic and chapter tracking are unchanged.', 403);
    if (!response.ok) throw new AppError('Wix orders could not be read. No sales figures have been changed.', 502);
    return response.json();
  };
  // Verify the immediately preceding equal-length period using the same
  // paid-order/refund/exclusion rules. Its failure cannot erase confirmed
  // current-period sales. No cross-period claim unless both are complete.
  const currentStart=selectedWindow?.start||shiftDate(today,-(days-1));
  const previousWindow={
    start:shiftDate(currentStart,-days),end:currentStart,days,range:'custom'
  };
  const [current,previous]=await Promise.all([
    buildSalesReport(request,days,today,selectedWindow),
    buildSalesReport(request,days,today,previousWindow).catch(()=>null)
  ]);
  const onlineCategories=current?.complete?await categorizePaidItems(current,request):null;
  const categorizedCurrent={...current,onlineCategories};
  if(!current?.complete||!previous?.complete||
     ![current.paidOrders,current.itemSalesCents,
       previous.paidOrders,previous.itemSalesCents].every(integer)||
     previous.range?.end!==current.range?.start){
    return {...categorizedCurrent,salesComparison:{
      status:'unavailable',previous:null,
      note:'Previous-period verified paid web orders are unavailable. Business direction remains unproven.'
    }};
  }
  return {...categorizedCurrent,salesComparison:{
    status:'reported',
    current:{paidOrders:current.paidOrders,itemSalesCents:current.itemSalesCents},
    previous:{paidOrders:previous.paidOrders,itemSalesCents:previous.itemSalesCents},
    previousRange:{start:previous.range.start,end:previous.range.end,days},
    note:'Two complete equal-length Wix WEB order reports. Approved and fully paid Wix Store orders only, excluding canceled/unpaid/refunded/disputed orders. Item sales are before tax and shipping. Sales growth is not margin or profit.'
  }};
}
const cache = new Map(), pending = new Map();
export const tradingPostSalesEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']); await authorize(req);
  const requestWindow=resolveReportWindow(req.query||{});
  const days=requestWindow.days, today=localDate(new Date());
  const key=requestWindow.start+':'+requestWindow.end;
  const old = cache.get(key);
  if (old && old.until > Date.now()) return res.json({ ...old.data, cached: true });
  let job = pending.get(key);
  if (!job) {
    job = load(days, today, requestWindow).then(data => { if (cache.size > 3) cache.clear(); cache.set(key, { data, until: Date.now() + 120000 }); return data; }).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return res.json({ ...await job, cached: false });
});
