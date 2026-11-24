# Daily Sales Master: latest owner layout

This supersedes the single Alcohol landing in `sales-distillery-layout.md`.
Keep the existing ledger and Alcohol conversions/workflow; place them within a
master page with five sections in this exact order:

1. Food
2. Alcohol
3. Swag
4. Events
5. Catering

The master is the entry point. An event is also a possible selling outlet for
Food/Alcohol/Swag. Save a transaction once under its primary section with its
outlet; do not copy the same sale into Events as a second transaction.

## Ownership

Backend author: existing Sales backend/test and daily log backend/test as needed.
Frontend author: only `sales.js`.
Reviewer: portable verifier and appended Sales master/operations CSS in `sales.css`.
Root: new product-catalog backend/test, route dispatch, app/report navigation,
report CSS, preview, docs, asset versions and deployment. Root independently
reviews the final rendered appearance. No historical workbook imports.

## Saved sale fields

Optional new fields, blank for old records:

```
division: '' | 'food' | 'alcohol' | 'swag' | 'events' | 'catering'
outlet: '' | 'online' | 'farmers_market' | 'event' | 'catering' | 'in_store' | 'other'
customer: {name,email,companyName,contactName,phone,address}
items: [{...existing, packageLabel:''}]
```

New UI records choose a division. New retail records use existing `channel:'retail'`
and an explicit outlet; wholesale uses `channel:'wholesale'`. Keep all old channel
values compatible. Recording a division-classified retail sale requires an outlet;
recording a division-classified wholesale sale requires `customer.companyName`.
Company/contact names max200, phone max80, address max1000, package label max120.
Company info appears in detail/print/CSV; no tax/identity/account numbers requested.
Preserve old create-request hashes and omitted metadata where applicable.

Food retail choices: Online, Farmers market, Events, Other.
Alcohol retail choices: Events, Catering, In-store, Other.
Swag can use Online, Farmers market, Events, In-store, Other.
Events and Catering offer their named outlet and Other.
Wholesale is available with company details (Food explicitly requires it; retain
existing wholesale support for Alcohol and other sections).

## Products and sizes

Owner explicitly supplied two current Food products: **Boss Soss** and
**Sweet Bayou**, each **12 oz bottle**. Prices are unknown and remain blank.
Store the food package label as given; do not assume fluid ounces, convert it to
milliliters, or treat it as spirits volume. A starter product is a reusable choice,
not a sale, opening inventory, or private database write.

Alcohol retains explicit 50/100/150/375/750 mL and custom size, pack count and proof.
Products from any section can be added easily. Other sections start empty.

New API `/api/meta/sales-products`:

GET `?businessId=...` returns `{businessId,products:[...]}`. Include two Food
starter choices (merged with saved edits), plus business-scoped saved products.
Each product includes:

```
{id,businessId,revision,division,name,sku,packageLabel,unit,defaultPrice,
 bottleSizeMl,bottlesPerUnit,proof,active,createdAt,updatedAt,
 createRequestId,lastRequestId,historyCount}
```

Default units: Food bottle, Alcohol bottle, Swag each, Events/Catering service.
Starter IDs: `starter_food_boss_soss` and `starter_food_sweet_bayou`, revision0.
GET `?businessId=...&id=...` returns `{product}` with full history; unknown ID fails.
The frontend may use current summary values for an edit and let the revision check
protect it, or fetch the full product first if showing its history.

POST:

```
{action:'save',businessId,id?,expectedRevision:0,requestId:'stable-id',
 product:{division,name,sku,packageLabel,unit,defaultPrice,
          bottleSizeMl,bottlesPerUnit,proof,active:true}}
```

New records require revision0; existing edits exact revision. Return
`{success:true,product}`. Stable request replay and atomic revision checks apply;
business+request mapping prevents duplicates after lost responses. The frontend
holds uncertain writes and reuses their exact IDs/payloads. No hard deletion.
`active:false` archives a choice, preserving historical sale snapshots.
Defaults never rewrite existing sale lines. Product prices/size/proof are copied
into a NEW editable sale line and then saved as that sale's own snapshot.

Catalog limit500 saved choices per business; history limit100 rejecting further
edits instead of truncating. GET lists compact summaries (not full histories).
Root implements the endpoint. Backend author must not edit its files.

Saved product lists read compact summary keys. Product history records the actor,
request ID, revision, time and before/after defaults. Price stays blank until
known; nonblank prices normalize to two decimals. Bottle size/proof fields apply
only to Alcohol products; Food keeps the supplied package label. Pack counts are
available for case units. The two starter IDs stay in Food; add a separate product
for another section. Archived products remain in the catalog response with
`active:false` so historical choices and edits remain visible.

## Main page and subsection behavior

- Header: **Daily Sales Master**; company/business selector always visible.
- Five main cards with the section name, recorded sales amount/count and status
  for the selected day. Default day is today in America/Chicago, with an explicit
  day picker. Counts/amounts exclude drafts and voids; received payments remain
  distinct from sales. Show a clear link to the complete ledger/history.
- Clicking a section opens that section's ledger and appropriate sale-entry
  defaults. New sale has a division selector; do not infer old blank divisions.
- Food shows the two starter products/sizes and **Add product**. All five sections
  support adding appropriate products/services and viewing their saved sales.
- The extended month/half-month/size/proof board lives **inside Alcohol**, with
  a compact collapsible daily visitor log. It is not a giant master landing.
- The visitor log is specifically Alcohol retail visitors for the selected
  business. API keys stay business+date; label the scope clearly. Average spend
  uses only `division:'alcohol'` and `channel:'retail'` sales with visitor coverage.
- Alcohol volume summaries include classified spirit bottle lines across ALL
  sale divisions for that business/month, so alcohol in a Catering sale is counted
  once. Label this scope. Financial master cards count the sale only in its saved
  primary division. Missing size/proof remains unknown.
- Retain actual report navigation business+type+month and form-specific units.
  Automatic field mapping/filing remains pending; no inferred production or stock.
- Legacy blank-division records remain visible in the all-record ledger with an
  Unassigned section label; do not silently attribute them to Food or Alcohol.
- Daily entry, catalog editing, and sale entry share busy/dirty/uncertain/reset
  guards. Day/category changes must not discard unfinished entries silently.

## Focused verification

Keep existing financial/daily/conversion tests. Add only the introduced risks:
division/outlet/customer normalization and required new fields; legacy replay;
5-section once-only counting; Food12oz separate from alcohol mL; catalog business
isolation, GET no-write starter choices, immutable sale snapshots, revision/replay
and archive; Alcohol visitor denominator versus all-division bottle volume; and
company information in saved review/export. All test data is synthetic.
