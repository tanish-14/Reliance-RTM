# RCPL Route-to-Market (RTM) Platform

Offline-first distribution management for RCPL: field sales (DSR), distributor fulfilment, HQ, retailer and admin surfaces on one platform. Status by phase: see [PROGRESS.md](PROGRESS.md).

```
packages/shared   pricing / margin / scheme engine, GST, order state machine, zod schemas (used by device AND server)
apps/api          NestJS + Prisma + PostgreSQL — auth, RBAC, sync, orders, fulfilment, ledger, audit
apps/web          React + Vite PWA — Dexie (IndexedDB) offline store, sync queue, role shells
```

## Run locally

Requires Node 20+.

```bash
npm install
```

**1. Database.** Either Docker:

```bash
docker compose up -d
```

(then set `DATABASE_URL` in `apps/api/.env` to port **5432**), or, with no Docker, a real embedded PostgreSQL 17 on port **5433** (keep it running in its own terminal):

```bash
npm run db:embedded
```

**2. Configure, migrate, seed.**

```bash
cp .env.example apps/api/.env
```

```bash
npm run build:shared
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

To start over with a clean database later: `npm run db:reset` (drops all data, re-migrates, re-seeds — local dev DB only).

**3. Start the API and the web app** (two terminals):

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open http://localhost:5173. The API listens on http://localhost:3000/api (`/api/health`).

To try the real installable/offline PWA (service worker is only generated in a build):

```bash
npm run build -w @rtm/web && npm run preview -w @rtm/web
```

then open http://localhost:4173.

## Demo logins

All seeded accounts use password **`Rcpl@1234`** (demo data only). The login page has one-click buttons.

| Role | Email |
|---|---|
| DSR (Mumbai, has a van) | `dsr.ravi@rcpl.test` |
| Other DSRs | `dsr.sunil@` (Mumbai, pre-sell), `dsr.hetal@` (Ahmedabad), `dsr.aman@` (Delhi), `dsr.kavya@` (Bengaluru) |
| Distributor | `dist.mh01@rcpl.test` (also `dist.gj01@`, `dist.dl01@`, `dist.ka01@`) |
| HQ / managers | `hq@rcpl.test`, `rsm.west@`, `asm.mumbai@` … (each sees only their territory) |
| Retailer (one per channel) | `retailer.gt@`, `retailer.mt@`, `retailer.ecom@`, `retailer.qcom@`, `retailer.horeca@` |
| Admin | `admin@rcpl.test` |

## Demo script (the Phase 1 + 3 slice)

1. **DSR** (`dsr.ravi`) — open on a phone-size window. Masters download to IndexedDB.
2. *Settings → Airplane mode (demo)* on. *Today → Check in* (geofenced; outside the fence is recorded + flagged).
3. Open **Gupta Super Mart** → *Take order*: 48 × Campa Cola 200 ml, 16 × Atta 5 kg, 24 × Soya oil. The device prices it offline: GOLD-tier margin, `CAMPA-WINTER-QTY` slab, `CAMPA200-FREE` (+4 free), `IND-VALUE-SLAB`, CGST+SGST.
4. *Collect payment* → cash ₹1,500. *Sync queue* shows 3 items **Waiting**.
5. Airplane mode off → all **Synced** with order/receipt numbers. *Replay synced items* → server answers **3 DUPLICATE** (nothing created twice).
6. **Distributor** (`dist.mh01`) → the order → *Fulfil & invoice* (FEFO; near-expiry batches held back for GT) → *Mark delivered* → order **CLOSED**.
7. **HQ** (`hq`) → secondary sales, AR exposure and cash-in-transit reflect the above.

More edge cases to try:
- **Credit breach:** Laxmi Kirana (first outlet on every beat) has a ₹2,000 limit — a bigger order syncs as **ON_HOLD / CREDIT_BREACH**; approve or reject it on the HQ overview.
- **Partial fulfilment:** Atta 10 kg has only 6 units at MH01 → invoice ships 6, order goes **PARTIALLY_FULFILLED** with **BACKORDER**; *Close backorder* or fulfil again later.
- **Outlet served by two models:** Om Sai General Store (Ravi's 2nd outlet) gets Campa off the van (invoiced + delivered on the spot) and staples distributor-led — one order on the device becomes two on the server.
- **Cancel after invoice:** cancelling an undelivered invoiced order issues a credit note and a reversing journal.
- **Damaged return:** DSR *Market return* → distributor *Returns → Accept & credit* → credit note, AR reduced, stock into the DAMAGED bucket.

## Tests

```bash
npm test
```

Runs the shared engine tests (pricing, schemes, GST, GSTIN, routing, state machine).

## Guarantees enforced in the database

See `apps/api/prisma/migrations/*_immutability/migration.sql`:
- `AuditLog`, `Journal`, `LedgerEntry`, `StockMovement`, `SecondarySale` reject UPDATE / DELETE / TRUNCATE.
- Every journal must balance (deferred constraint trigger at commit); ledger lines are one-sided.
- Stock can't go negative; sync idempotency keys are unique per tenant.
