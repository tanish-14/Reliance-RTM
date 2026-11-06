# PROGRESS — RCPL RTM Platform

Status legend: ✅ done & verified · 🟡 partial · ⬜ not started

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Monorepo, Docker Compose, Prisma, JWT, RBAC + hierarchy scoping, immutable audit, tenancy, seed, role shells, **TOTP MFA for HQ/admin** | ✅ |
| 2 Master data | Admin create/update for products, distributors, outlets (+ RTM mappings, credit), people/hierarchy, beats, channels, RTM models, margins; dated price versions; CSV bulk import (dry run, all-or-nothing); GSTIN checksum + state check | ✅ |
| 3 GT order-to-cash | Offline DSR PWA, geofenced attendance/visits, orders, returns, cash/UPI/cheque collection, idempotent sync, distributor fulfilment (FEFO, backorders), invoices, secondary sales | ✅ |
| 4 Money & schemes | Double-entry ledger; online payments (Razorpay interface + mock, signed idempotent webhooks, refunds, settlement); COD; cash deposit variance; UPI verification; cheque lifecycle + bounce auto-block; bank transfers; bank-statement recon + exception queue; ageing + auto-block; schemes (qty/value slab, free goods, trade discount, combo, cashback, time/geo/channel-bound, budgets); claims validated vs secondary sales, de-dup, settlement; debit note for scheme in error; GST IRN + e-way bill (mock IRP); credit-note IRN | ✅ |
| 5 Omni-channel | Retailer eB2B PWA (offline catalogue, schemes, credit, checkout with Khata / COD / online); MT / e-com / q-com intake via one configurable adapter onto the same order lifecycle | ✅ |
| 6 Intelligence | HQ KPIs (numeric / weighted distribution, strike rate, pipeline gap, scheme ROI, credit exposure + ageing, cash-in-transit), approval workflows (maker-checker, level by amount + territory), integration stubs (ERP, 3PL, JioMart Partner), DPDP consent + data-subject rights | ✅ |

---

## Verification log

### 2026-11-04 — phases 2, 4, 5, 6

Automated: shared **21/21**, API e2e **50/50**, passing on three consecutive runs (real Postgres; DB rebuilt per run). Production builds: web (service worker, 11 precached entries, 153 KB gzip JS) and API both succeed.

Checked in the browser against the running app:
- Admin: CSV outlet import dry-run → VALID; import history recorded.
- Retailer (`retailer.gt`, phone viewport): DPDP consent gate → shop with offers priced on the device → **Pay now** → mock checkout → *bank decline* recorded ("you can try again") → *success* → signed webhook → order **CONFIRMED** (prepaid). **COD** order placed.
- Distributor: COD order fulfilled → *Delivered + collect COD* → order **CLOSED**; **IRN generated** by the background job within seconds; *Receipts* show the ONLINE (₹1,285.20) and COD CASH (₹420) receipts.
- HQ: forced **MFA enrolment** (secret + otpauth link; demo code) → KPIs page from live data → **Approvals**: scheme activation requested by admin, approved by HQ → scheme ACTIVE.
- Admin: partner simulator → SHOPKART order ACCEPTED (`SO2627-000003`); resend → **DUPLICATE** with the same order number.
- DSR: day-end cash screen.

Found and fixed during verification:
- **Embedded Postgres was WIN1252** (initdb took the Windows code page) → "₹" / "→" could not be stored. `scripts/dev-db.mjs` now creates UTF-8 databases and warns about existing non-UTF-8 ones; the local dev/test DBs were recreated as UTF-8 and re-seeded.
- Mock IRP ack number overflowed `crypto.randomInt`; advisory locks used `$queryRaw` on a `void` result.
- Test harness: `getApp()` raced under concurrent first requests (two Nest apps / Prisma engines) → memoised; KPI test made independent of file order.
- UI: `window.prompt` (blocks automation, poor on phones) replaced by inline inputs; retailer order list refreshes after placing.

### 2026-11-04 — phases 1 + 3 slice
DSR offline visit → sync once (replay = DUPLICATE) → distributor fulfil/deliver → GST invoice → HQ figures; credit hold, two-model split, partial fulfilment, cancel-after-invoice, damaged return, RBAC.

---

## Decisions & assumptions (flagged)

- **A1 No Docker on the dev machine.** Compose file provided; this machine uses `embedded-postgres` (`npm run db:embedded`, port 5433, UTF-8).
- **A2 Job queue = transactional outbox in Postgres.** Jobs are written in the same transaction as the change; the `pg` driver claims rows with `FOR UPDATE SKIP LOCKED`. `QUEUE_DRIVER=bullmq` relays rows into BullMQ on Redis. **The BullMQ driver is written but not exercised here (no Redis on this machine).**
- **A3 Money** is integer paise in BIGINT; JSON numbers (safe < 2^53).
- **A4 Books.** Secondary sales and receivables are in each distributor's books; scheme claims post in both RCPL's (`COMPANY`) and the distributor's books.
- **A5 Price changed offline.** Orders are priced as of capture time (≤72 h back); a higher server total holds the order (`PRICE_MISMATCH`); stale captures are priced now and flagged.
- **A6 Credit.** Exposure = ledger AR + uninvoiced confirmed orders. Breach / block → hold, never drop. COD and prepaid orders skip the credit check. Outlets without a credit account are cash-only.
- **A7 Geofence** violations are recorded and queued for review, not rejected.
- **A8 Inventory** is a per-batch quantity (row-locked) + append-only movements.
- **A9 Online payments.** The browser never marks money received; only a signed webhook does. Payment attempts can fail and be retried within the intent's 15-minute life; afterwards the intent expires and a prepaid order is cancelled. A late capture is kept and goes to the exception queue (refund or re-apply).
- **A10 Field UPI** sits in UPI clearing until verified (mock rule: UTR ending `0000` fails → explicit reversal); otherwise it is confirmed from the bank statement.
- **A11 Cash deposit variance** is posted explicitly: a shortage becomes a receivable from the agent (managers can write it off), an excess goes to suspense.
- **A12 Cheques** reduce dues on receipt; a bounce is an explicit reversing journal. Two bounces auto-block credit. Auto-blocks lift themselves when cured; manual blocks don't.
- **A13 Ageing** is FIFO open-item (receipts settle the oldest invoices first), derived from the ledger, never stored.
- **A14 Scheme cost evidence** (`SchemeUsage`, append-only) is written at invoice, reversed on cancellation/correction. Claims, budgets and ROI all read it. Claim de-dup: any overlapping period for the same distributor + scheme is rejected; over-claims are trimmed to what sales support and flagged `INFLATED`.
- **A15 Scheme stacking.** Best of quantity-slab / trade-discount per line; best free-goods per line; combos, then value slabs at order level (one order-level discount per line); cashback is credited after delivery (pro-rata if short-closed), not a price change. Free goods are same-SKU only.
- **A16 GST.** IRN for B2B invoices and credit notes; B2C (no buyer GSTIN) is `NOT_APPLICABLE`. E-way bill above ₹50,000 using a road distance of 1.3 × straight line. IRN cancellation only within 24 h, otherwise the credit note stands. Debit notes (scheme corrections) don't get an IRN yet. The provider is a mock IRP behind `GstProvider`.
- **A17 Approvals.** Levels: ASM 1, RSM 2, National/admin 3, from hierarchy depth. Thresholds are in `LEVEL_RULES` (code constants). One approval at the required level suffices (no multi-step chains). Requesters can't approve their own requests.
- **A18 MFA.** TOTP (RFC 6238, verified against the RFC test vector) for MANAGER/ADMIN; enrolment is forced at first login. `DEMO_MODE=1` echoes the current code (ignored in production).
- **A19 DPDP.** Purpose-wise consent, append-only. eB2B ordering requires `ORDER_PROCESSING` consent (enforced server-side). Erasure anonymises person data (user and outlet owner) but keeps invoices/ledger for statutory retention.
- **A20 Channel intake.** One generic adapter with field-path config per partner + store/SKU maps. A PO value below our price → hold; no PO value → our price. A partner's "user" is an inactive SYSTEM account that can't log in.
- **A21 Data residency & encryption at rest** are deployment concerns (documented in the README), not app code.
- **A22 Single Nest module** (all providers in `AppModule`); split later if teams need module boundaries.
- **A23 Prisma `migrate dev` / `reset` are blocked for AI agents** (and `migrate dev` needs a TTY for warnings). Agent-made migrations were generated with `migrate diff` and applied with `migrate deploy`.

## Open items

- Exercise the BullMQ driver against a real Redis.
- Real connectors: Razorpay live verification, a GSP for IRN / e-way bill, the ERP (SAP) adapter, a 3PL, JioMart Partner APIs.
- Partial delivery at the door (short quantity → automatic credit note); order modification after placement.
- Debit-note IRN; e-way bill Part-B (vehicle) update.
- Multi-step approval chains and configurable thresholds per tenant; audit-log hash chaining.
- Refresh tokens; device binding for field logins.
- Load / low-end-Android performance testing; true offline reload of the installed PWA on a device.
