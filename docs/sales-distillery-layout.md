# Distillery Sales layout extension

The latest five-section master layout is specified in `daily-sales-master.md`.
Its primary-section and outlet rules supersede this document's main landing
structure. The Alcohol conversion and reporting details below still apply within
the Alcohol section.

The owner supplied a historical worksheet as a layout reference. Reuse its flow:
people arriving, recorded retail spending, products and bottle sizes, first half
and second half of a calendar month, then Excise, Production, Storage, Processing.
Do not import its taxpayer identity, historical figures, tax rates, products,
inventory, formulas, or California-specific classifications into either business.
The owner supplied both a pasted worksheet and its Excel workbook. The workbook
preserves formulas and external-workbook references; the source contains
inconsistent headings and an error marker. It is a layout reference, not a
validated accounting or tax-calculation source.

## Ownership

Backend author owns `lib/sales.js`, `test/sales.test.js`, new
`lib/sales-days.js`, and new `test/sales-days.test.js`.
Frontend author owns only `sales.js`.
Root owns CSS, API routing, host navigation, report navigation, preview, version
bumps, documentation and deployment. Reviewer owns the portable workflow verifier
and independently reviews the extension. All work builds on the deployed Sales
v1; its separate businesses, money calculations, idempotency and history remain.

## Sale line metadata

Add optional input fields to each item:

```
purpose: '' | 'bottle_sale' | 'tasting' | 'cocktail' | 'sample' | 'other'
bottleSizeMl: '' | positive integer string, maximum 100000
bottlesPerUnit: '' | positive integer string, maximum 1000
proof: '' | positive U.S. proof decimal string up to 200, maximum 3 decimal places
```

New spirit items default to `purpose: 'bottle_sale'`. The UI offers 50, 100, 150,
375, and 750 mL plus a custom size (including 350 mL). Labels make clear that the
size is for ONE bottle. For `unit: 'case'`, explicitly enter the number of bottles
in that case or pack; never assume a three-pack means three 750 mL bottles.
`unit: 'bottle'` means one bottle per quantity unit.

Only `category: 'spirits'`, `purpose: 'bottle_sale'`, and `unit: 'bottle'|'case'`
qualify for bottle totals. Recorded qualifying lines require a positive whole
quantity, explicit bottle size, and a positive bottles-per-unit count for cases.
New metadata is optional for older records/drafts; preserve backward compatibility
and label old/unclassified spirit lines as needing size/use classification.
Do not infer bottle usage from a tasting, cocktail, sample, or generic sale line.

Saved qualifying item fields include `bottleCount`, `volumeMl`,
`wineGallonsMicros`, and `proofGallonsMicros` as exact safe nonnegative integers,
or null when incomplete/inapplicable. One microgallon is one millionth gallon.
Use exact integer math and reject unsafe results. Missing proof leaves proof
gallons unknown while the known physical volume remains available. Newly
classified bottle-sale lines require proof before recording; legacy blank-purpose
lines remain compatible. Extend saved detail, editor, CSV and tests. Show proof
and derived ABV (proof divided by two), without defaulting all products to 80 proof.

### Owner clarification: proof-gallon conversions are required now

The latest owner clarification explicitly requires the conversion layer on the
main alcohol Sales page. This supersedes the earlier deferral of proof gallons.
Keep actual quantity/size/proof alongside all derived amounts. Display mL, liters,
wine gallons, and proof gallons by product and period; use six decimal places for
the gallon figures and identify missing size/proof rather than reporting zero.

Verified primary sources (November 24, 2026):

- https://www.ttb.gov/regulated-commodities/beverage-alcohol/distilled-spirits/conversion-tables
- https://www.ecfr.gov/current/title-27/section-19.582
- https://www.ecfr.gov/current/title-27/section-30.52
- https://www.ttb.gov/regulated-commodities/beverage-alcohol/distilled-spirits/distilled-spirits-faqs

Use TTB's distilled-spirits conversion factor: liters × 0.264172 = wine gallons.
Proof gallons = wine gallons × U.S. proof / 100. Proof is twice ABV.
For cases, use the permitted per-case method: round one case's wine gallons to
six decimals, then multiply by the number of same-proof cases; then apply proof.
For loose bottles, retain the full factor until rounding the final line result.
Do not use a wine-product factor, assume proof, or reuse the historical sheet's
tax rates. This is sales-volume support; it does not determine taxable removals,
tax liability, operational transfers, production or closing stock.

Exact implementation with `proofMilli` = proof × 1000 and half-up integer rounding:

```
case wineGallonsMicros = round(unitVolumeMl * 264172 / 1000) * quantity
case proofGallonsMicros = round(wineGallonsMicros * proofMilli / 100000)
loose wineGallonsMicros = round(volumeMl * 264172 / 1000)
loose proofGallonsMicros = round(volumeMl * 264172 * proofMilli / 100000000)
```

These support values do not change form-specific rounding or units. For example,
TTB F 5110.28 Part IV includes both whole-proof-gallon and whole-wine-gallon columns:
https://www.ttb.gov/system/files/images/pdfs/forms/f511028.pdf

## Daily visitor log API

Use new owner-authenticated endpoint `/api/meta/sales-days`. Existing core
authentication, Origin/CSRF, Redis locks and atomic revision checks apply.
One current daily entry per business and calendar date (all retail visitor totals
for that business). No writes on GET, seeded days, historical imports or delete.

GET `sales-days?businessId=conestoga&month=YYYY-MM` returns:

```
{businessId,month,timezone:'America/Chicago',days:[{
 id:'YYYY-MM-DD',businessId,date:'YYYY-MM-DD',revision,
 visitors:'',tastings:'',cocktails:'',tipsAmount:'',tipsCents:null,
 notes:'',createdAt,updatedAt,createdBy,updatedBy,historyCount
}]}
```

Calendar month response contains at most 31 current entries and omits history
arrays. GET `sales-days?businessId=...&date=YYYY-MM-DD` returns `{day}` with the
full history (or `day:null` for a new date). Validate dates as actual calendar
dates. Count inputs are blank unknown or nonnegative integer strings up to
1,000,000. Tips are blank unknown or nonnegative USD decimal strings using the
same money rules as Sales. Preserve blank versus zero. Notes max 2000 characters.
Recorded daily dates cannot be future in America/Chicago.

POST:

```
{action:'save',businessId,expectedRevision:0,requestId:'stable-id',
 day:{date,visitors,tastings,cocktails,tipsAmount,notes}}
```

New date expects revision 0; edit expects exact saved revision. Date and business
are immutable for an existing entry. Stable request ID + same normalized payload
must return saved result without another history entry, even after later revisions;
changed payload under the same ID fails. Save returns `{success:true,day}` with
full history. Preserve history; reject at a practical limit (200 events), never
drop older events. Record actor/time and before/after metrics. Deterministic date
keys prevent duplicate days. Concurrent create/update must not overwrite values.
GET month should use only bounded keys for that month and not load all history.
No card/payment operations, report submissions or inventory changes.

## Main Sales view

Keep business selection and the established brass/parchment/copper-pipe style.
Add a calendar-month picker defaulting to the current Central-time month. Main
operating overview always uses that month and selected business; ledger filters
below remain independent and their scope is explained.

1. **People & spending**: incoming visitors, recorded retail spend, average retail
   spend per visitor, and manually logged tips. Show first-half (days 1–15),
   second-half (16–last calendar day), and full-month comparison. Include manually
   logged tastings/cocktails. Blank daily counts or tips stay unknown, never zero.
   Retail spend is the sum of recorded retail sale totals, excluding drafts/voids;
   tips are a separate daily log and never added to sales/payment totals. Label
   retail spending scope (includes entered tax/shipping, excludes logged tips).
   An average requires a positive known visitor count and visitor coverage for
   every day with recorded retail sales in that period; otherwise show unavailable
   and explain missing visitor entries. Label visitor totals as logged totals and
   indicate coverage, since a missing day is not a confirmed zero-visitor day.
2. **Daily entries**: collapsible month rows showing date, logged people, computed
   recorded retail spending, tips, tastings, cocktails, and Edit/Enter. A new daily
   entry form can be opened from the top. Fetch the full day before editing;
   show its history. Save directly with revision/idempotency protections. It is
   an activity log, not a second sales ledger. Do not enter a duplicate manual
   dollar-sales field. Integrate dirty/busy/reset/uncertainty guards with Sales.
3. **What they bought**: bottle counts by product and 50/100/150/375/750 mL plus
   custom sizes; first-half/second-half/month and channel selection (all, retail,
   wholesale, other). Sum only recorded qualifying bottle-sale lines; show total
   bottles, mL/liters, wine gallons and proof gallons, with explicit unclassified,
   missing-size, and missing-proof counts. No excise liability calculation yet.
   Tasting/sample consumption and
   bottling-production numbers are separate future movement records.
4. **Reports**: four small linked sections in owner order: Excise → Production →
   Storage → Processing. Buttons call
   `window.djomsOpenSalesReport(businessId, templateId, month)`, where template IDs are
   `ttb_excise`, `ttb_production`, `ttb_storage`, `ttb_processing`. Root supplies
   authenticated navigation into the real report module for that business/type/month.
   Mark automatic data transfer as pending. Do not claim a prepared, approved,
   filed or tax-calculated result from sales data alone.
5. Preserve the v1 searchable sales ledger, saved review/record flow, received
   payments, void constraints, audit, export and print.

The static layout preview must add an empty local fixture for sales-days, block
all writes and account access, and keep its preview banner. Never embed source
worksheet data in the public preview, tests, JS/CSS or documentation.

## Verification

Use only synthetic records. Cover 1st/2nd-half boundaries including February,
business separation, blank/zero visitor counts, average coverage and zero division,
tip separation, whole bottle/explicit pack conversion, custom/unknown sizes/proof,
TTB conversion factor and case rounding, proof versus ABV, unknown rather than
zero proof-gallon totals, precision and safe bounds,
exclusion of tasting/cocktail/sample/draft/voided lines, stable daily keys and
revisions/idempotency, full daily history, reset/uncertainty behavior, and report
navigation retaining the selected business. No live financial or historical data
imports. Do not add tests beyond concrete risks introduced by this extension.
