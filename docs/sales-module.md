# DJOMS main Sales page

The current landing and product/outlet model are specified in
`daily-sales-master.md`: Food, Alcohol, Swag, Events, Catering. The Alcohol
conversion and daily visitor details are in `sales-distillery-layout.md`.
The original sale/payment protections below remain in force.

This module records owner-entered sales and payments already received. It does
not charge cards, move money, submit filings, alter inventory, post accounting
entries, import Wix orders, or process refunds. The existing Wix website-sales
report remains a separate read-only report.

## Business scope

Use existing IDs `conestoga` (label **Colo Distillery LLC**) and `doc_jaks`
(label **Doc Jak's**). Every record belongs to one business and cannot be
reassigned after creation. No real account identifiers or customer records are
included in source, public assets, fixtures, or initial database seeds.

## Module and API

Frontend: `sales.js`, `sales.css`; active view `Sales`; route `/sales`.
Expose `window.djomsSales = {render,load,reset,onLeave,isDirty,leaveDraft,clearDirty}`.
Use the existing global `api`, `notice`, `activeView`, `dirty`, and `#content`.
Root owns application navigation, routing, API action dispatch, and deployment.

Backend: `lib/sales.js`, endpoint `salesEndpoint`, routed as `/api/meta/sales`.
Existing owner authorization, Origin, CSRF, record locks and revision checks
apply. GET never creates records. Writes use the same private Redis store.

`GET sales?businessId=conestoga[&cursor=...]` returns:

```
{sales:[], businesses:[{id,name}], businessId, timezone:'America/Chicago',
 nextCursor:null, connections:{inventory:false,accounting:false,reports:false}}
```

GET returns at most 50 records and stays below a 3 MB serialized response.
Use a stable index score on edits, follow every page, and do not silently skip
records. Client deduplicates IDs and rejects cursor cycles and stale responses.

## Draft input

```
{
 businessId:'conestoga', soldOn:'YYYY-MM-DD', dueDate:'',
 channel:'retail', location:'', sourceReference:'',
 customer:{name:'',email:''}, notes:'',
 items:[{description:'',sku:'',productId:'',batchReference:'',category:'spirits',
         quantity:'1',unit:'bottle',unitPrice:''}],
 discountAmount:'0.00', taxAmount:'', shippingAmount:'0.00',
 initialPayment:{amount:'',method:'',date:'',reference:'',notes:''}
}
```

Channels: `retail`, `wholesale`, `event`, `website`, `other`.
Categories: `spirits`, `food`, `swag`, `music`, `books`, `bundles`, `other`.
Units: `each`, `bottle`, `case`, `gallon`, `liter`, `pound`, `kilogram`, `service`.
Payment methods: `cash`, `card`, `bank`, `check`, `other`.

All money input is a nonnegative decimal string with at most two places. Quantity
is positive, at most six decimal places. Use exact decimal arithmetic. Round each
quantity × unit-price line to cents, half up. Sum rounded lines, subtract the
explicit discount, then add explicit tax and shipping amounts. Never infer a tax
rate, tax jurisdiction, payment, profit, or inventory quantity. Keep blank unknown
values in drafts; recording requires complete descriptions, quantities, prices
and an explicit tax amount (including 0 where appropriate). Discount cannot
exceed subtotal. Reject overpayments and values exceeding safe bounded totals.
No CVV, card number, bank credentials, or payment tokens are collected.

Recorded sale dates/payment dates must not be in the future (America/Chicago).
Drafts may be incomplete. Dates are validated as real calendar dates.

## Saved records

Input fields plus:

```
{id,number,revision,status:'draft'|'recorded'|'voided',
 createdAt,updatedAt,createdBy,recordedAt:null,voidedAt:null,
 items:[...inputItemWithLineTotalCents],
 totals:{subtotalCents,discountCents,taxCents,shippingCents,totalCents,
         paidCents,balanceCents},
 paymentStatus:'unpaid'|'partial'|'paid',
 payments:[{id,requestId,date,method,amount,amountCents,reference,notes,
            recordedAt,recordedBy}],
 history:[{at,type,user,message}]}
```

An unknown draft total is `null`, not zero. Payment totals are derived from saved
payment entries. Draft initialPayment is clearly a draft and joins payments only
when the sale is recorded. Recorded sale financial fields are immutable; later
payments append an event. The interface explains that recording a payment does
not process a charge. Voiding requires a reason and zero recorded payments.
Void keeps the original record and history. No permanent deletion endpoint.

## Actions

All POSTs include `businessId`; existing records also include `id` and exact
`expectedRevision`. Return `{success:true,sale}`.

* `save`: `sale` contains draft input. New saves also carry a stable `requestId`.
  Repeating the same create request must not create duplicates. A reused request
  ID with a changed payload must fail. Existing saves are draft-only.
* `record`: validates a saved draft and records its exact revision, including any
  entered initial payment. No provider/network payment calls occur.
* `recordPayment`: carries stable `requestId` and `payment:{amount,method,date,
  reference,notes}`. Recorded sales only. Enforce remaining balance and duplicate
  request detection. Reused payment IDs with changed payloads fail.
* `void`: carries `reason`; saved draft or recorded unpaid sale only. Preserve
  financial values and audit history; exclude from sales totals.

Bound text, line count (max 100), histories and payment count to practical limits.
Expected revision and owner-only permissions protect concurrent actions. Tests
must block every live request and validate exact arithmetic, business isolation,
auth/CSRF, idempotency, payment limits, immutable records, void history, pagination
and date validation. They must not send or create production data.

## User interface

Use the approved brass/parchment and copper-pipe style, with small single-color
green/yellow/red lights and strong contrast. Default to Colo Distillery LLC.
Display an honest empty state without sample transactions. Main actions: New
sale, history/search/filter, CSV export, and a link to existing website analytics
for Doc Jak's. Main overview: recorded sales before tax, recorded receipts,
outstanding balance, recorded sale count. Explain date/filter scope; exclude
drafts and voids from financial totals. Draft and overdue counts provide status.

Sale editor: business, date, channel/location, customer/reference, item lines,
discount/tax/shipping, optional initial received-payment details, notes, totals,
Save draft. Detail: exact saved record, edit draft, explicit Record sale, record
received payment, print, void with reason, and audit history. All mutation controls
disable during requests. Unsaved edits must survive redraws and require explicit
discard on navigation; logout/reset invalidates every pending response.

Render all entered text safely. CSV export neutralizes spreadsheet formulas.
Print uses the selected business and saved line/payment values. Keep future
connections visible but do not present them as working feeds.

User policy retained: refunds are restricted to management; amounts over $200
require Jay approval. Refund processing is outside this first page and must not
be introduced through a generic payment or void action.

## Navigation and review

The owner page is `/sales`; the existing Reports page remains `/reports`.
Both routes verify the owner session before loading their private data and can
start independently of social analytics. Session loss and sign-out reset module
state, invalidate pending responses, and clear the displayed private records.

`/sales-preview.html` is an isolated visual preview in the frontend repository.
It loads the same Sales component and styles with an empty local response. It
does not load the main application, call account APIs, or save changes. A visible
banner identifies it as a preview and links to the owner page. No real business
records or sample transactions are embedded in the public preview.
