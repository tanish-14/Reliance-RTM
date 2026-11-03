# PROGRESS — RCPL RTM Platform

Status legend: ✅ done & verified · 🟡 partial · ⬜ not started

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Monorepo, Docker Compose, Prisma v1, JWT, RBAC, immutable audit, tenancy, seed, role shells | ✅ (MFA open) |
| 2 Master data | Seeded + read/sync APIs + read-only admin view. Admin CRUD, bulk import: **not yet** (GSTIN validator exists) | 🟡 |
| 3 GT order-to-cash | Offline DSR PWA, attendance, orders, returns, cash/UPI collection, idempotent sync, distributor fulfilment, invoice + GST, secondary sales, double-entry ledger | ✅ (automated API tests open) |

## Verification log — 2026-11-04 (local, embedded Postgres 17)

Done in the browser (DSR on a 375 px viewport, then distributor and HQ):
- DSR offline (demo airplane mode): check-in, order at Gupta Super Mart (all 3 schemes + GOLD margin priced on device), ₹1,500 cash → 3 items queued → back online → all **Synced**, order not flagged (device total = server total). *Replay synced items* → **3 DUPLICATE**, nothing created twice.
- Distributor fulfil → GST invoice `MH01/2627/000002` (CGST+SGST, = order total) → delivered → order **CLOSED**.
- HQ overview: secondary sales, AR exposure and cash-in-transit match invoices minus collections.

Done by script against the running API:
- Credit breach → `ON_HOLD / CREDIT_BREACH` → HQ approve → `CONFIRMED`.
- Outlet served by two models → split into VAN_SALES (auto-invoiced + delivered, CLOSED) + DISTRIBUTOR_LED (CONFIRMED).
- Partial fulfilment (atta 10 kg short) → `PARTIALLY_FULFILLED` + `BACKORDER`.
- Cancel after invoice → credit note + reversing journal; AR back to its pre-invoice value; stock restored.
- Damaged return → credit note `MH01/CN2627/0002` at last invoiced price; AR reduced; stock in DAMAGED bucket.
- RBAC: DSR calling fulfil → 403; another state's distributor reading an MH01 order → 404.
- `npm run build -w @rtm/web` → service worker + manifest generated (precache 11 entries, 132 KB gzip JS).

Automated: `packages/shared` 15 vitest tests pass. **Not yet automated:** API e2e tests (sync dedupe incl. concurrent retries, ledger balance/immutability triggers, credit hold, price-changed-offline). The flows above were verified manually/by script only. Next increment.

Not verified yet: true offline reload of the installed PWA (needs `vite preview` build; dev mode has no service worker), real device GPS, low-end Android performance.
| 4 Money & schemes | Full payments, Razorpay, recon, full scheme engine, claims, IRN/e-way | ⬜ |
| 5 Omni-channel | Retailer eB2B, MT/e-com/q-com adapters | ⬜ |
| 6 Intelligence | HQ dashboards, approvals, integration stubs | ⬜ |

> Phase naming: the brief's closing line says "Phase 0 (foundation) and Phase 1 (GT order-to-cash)"; this file uses the numbered list in the brief (1 Foundation … 3 GT O2C). The slice delivered = Phase 1 + the master data Phase 3 needs (seeded) + Phase 3.

---

## Plan — Phases 1 + 3 (the proof-of-life slice)

**Goal:** a DSR captures a visit offline (attendance, order, cash collection), reconnects, it syncs exactly once; the distributor fulfils (FEFO, partial → backorder), invoices with GST, delivers; every money movement is a balanced, immutable journal; secondary sales recorded; HQ sees it.

1. **Monorepo** (npm workspaces): `packages/shared` (types, zod schemas, pure pricing/GST/state-machine logic used by both client and server), `apps/api` (NestJS + Prisma), `apps/web` (React + Vite PWA).
2. **Schema v1**: tenant-scoped tables for users/hierarchy, channel + RTM model *as data*, outlets + outlet↔model service mappings, distributors, products, price lists (effective-dated), schemes, inventory batches, orders/lines, invoices, deliveries, payments, returns, journals/ledger entries, credit accounts, attendance, sync inbox, audit log.
3. **DB-level guarantees** (raw SQL migration): audit log, journal and ledger entries are append-only (UPDATE/DELETE raise); every journal must balance (deferred constraint trigger); sync inbox unique on `(tenant, idempotency_key)`.
4. **Auth/RBAC**: JWT with tenant + role + scope; `@Roles()` guard; hierarchy scoping in services.
5. **Sync**: device outbox (Dexie) → `POST /sync/push`; each mutation keyed `deviceId:localId`, processed in one transaction with its inbox row; retries return the stored result. Server re-prices as of capture time and re-checks credit; breaches put the order **on hold** with flags, never dropped.
6. **Distributor flow**: confirm → allocate FEFO (skip expired) → invoice per RTM-model rule → deliver; ledger + secondary sales posted at invoice.
7. **Tests**: shared engine (pricing, GST, state machine, GSTIN), API e2e on a real Postgres (sync dedupe incl. concurrent retry, ledger balance/immutability, credit hold, price-changed-offline).

---

## Decisions & assumptions (flagged)

- **A1 No Docker on the dev machine.** `docker-compose.yml` (Postgres 16 + Redis 7) is provided, but this machine runs Postgres via the `embedded-postgres` npm package (`npm run db:embedded`, port 5433). Same Prisma URL shape either way.
- **A2 Redis/BullMQ deferred to Phase 4.** Nothing in this slice needs async jobs (sync is processed inline, transactionally). Redis is in compose; queues arrive with webhooks/recon/ageing jobs.
- **A3 Money** is integer paise in `BIGINT` columns; serialised to JSON numbers (safe < 2^53).
- **A4 Ledger books.** Secondary sales are the distributor's books: each journal has a `bookOwner` (distributor id or `COMPANY`). Outlet receivable, DSR cash-in-transit, sales, GST output, returns are accounts within the book.
- **A5 Price changed while offline.** Server prices the order *as of `capturedAt`* (effective-dated price lists + time-bound schemes). If the client's total differs from the server's, the server total wins and the order is flagged `PRICE_MISMATCH`. Orders captured > 72h before sync are flagged `STALE_CAPTURE` (device clock not trusted beyond that).
- **A6 Credit breach offline.** Order is accepted and placed `ON_HOLD` with `CREDIT_BREACH`; a manager approves or rejects. Exposure = ledger AR balance + uninvoiced open orders.
- **A7 Geo-fenced attendance.** Check-in outside the beat's geofence is recorded and flagged `OUTSIDE_GEOFENCE` for review (not rejected — offline devices can't be argued with). The DSR app has a dev "simulate location" toggle for demos.
- **A8 Inventory** keeps a quantity per batch (row-locked on allocation) plus an append-only `StockMovement` trail; money is never stored as a mutable balance.
- **A9 UPI collected in the field** is recorded with its UTR as `PENDING_VERIFICATION` and posted to a UPI-clearing account; gateway verification arrives with Razorpay in Phase 4.
- **A10 Component library.** Small owned Tailwind primitives (shadcn/ui pattern) instead of a heavy library, to keep the bundle small for low-end Android.
- **A11 Auth.** Single access token (12h) for now; refresh tokens + MFA (TOTP for HQ/admin) are open items.
- **A12 Repo lives in OneDrive.** OneDrive will try to sync `node_modules` and `.pgdata`; consider moving the repo or excluding those folders.

- **A13 Single Nest module.** All providers live in `AppModule` for this slice; split into feature modules when Phase 4 adds payments/schemes.
- **A14 Returns credit** at the outlet's last invoiced unit price for that SKU (what they paid), else current list price. Saleable returns go back to sellable stock only when the batch is known and unexpired; otherwise quarantined (DAMAGED).
- **A15 Outlets without a CreditAccount** are treated as cash/COD: no credit check.
- **A16 `prisma migrate reset` is blocked for AI agents** by Prisma; the agent seeded the fresh DB with `npm run db:seed` instead. `npm run db:reset` is for humans.
- **A17 Tailwind 4.0.0's Vite plugin crashes** on this stack; pinned 4.1.11.

## Open items

- **API e2e test suite** (vitest + supertest on `rtm_test`): sync dedupe incl. concurrent retries, ledger triggers, credit hold, price-changed-offline, RBAC/tenant isolation.
- MFA (TOTP) for MANAGER/ADMIN; refresh tokens.
- Audit-log hash chaining (tamper evidence beyond DB triggers).
- Partial delivery (retailer accepts fewer units at the door) → auto credit note for the short quantity.
- Order modification after placement.
- Admin CRUD + bulk import + GSTIN validation on write (Phase 2).
- IRN / e-way bill (mock provider behind interface) — Phase 4.
- Cash deposit reconciliation with variance exceptions — Phase 4.
- DPDP consent, encryption at rest — later.
