# RCPL Route-to-Market (RTM) Platform

Offline-first distribution management for RCPL: field sales (DSR), distributors, HQ / managers, retailers (eB2B) and admin on one platform, across GT, MT, e-commerce, quick commerce and HoReCa, and every delivery model (distributor-led, pre-sell, van sales, DSD, wholesale, eB2B) as configuration. Phase status and decisions: [PROGRESS.md](PROGRESS.md).

```
packages/shared   pricing / margin / scheme engine, GST, order state machine, zod schemas (device AND server)
apps/api          NestJS + Prisma + PostgreSQL: auth (JWT + TOTP MFA), RBAC, sync, orders, fulfilment,
                  double-entry ledger, payments & recon, schemes & claims, approvals, channel intake,
                  GST e-invoice, DPDP, analytics, job queue
apps/web          React + Vite PWA: Dexie (IndexedDB) offline store + sync queue; DSR, distributor,
                  HQ, retailer (eB2B) and admin surfaces
```

## Run locally

Requires Node 20+.

```bash
npm install
```

**1. Database.** Either Docker (Postgres 16 + Redis 7):

```bash
docker compose up -d
```

(then set `DATABASE_URL` in `apps/api/.env` to port **5432**), or, with no Docker, a real embedded PostgreSQL 17 on port **5433** (keep it running in its own terminal). It always creates UTF-8 databases:

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

To start over with a clean database: `npm run db:reset` (drops all data, re-migrates, re-seeds; local dev DB only).

**3. Start the API and the web app** (two terminals):

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open http://localhost:5173. API: http://localhost:3000/api (`/api/health`). Background jobs (e-invoice, UPI verification, payment expiry, credit review, integrations) run inside the API process on the Postgres-backed queue; set `QUEUE_DRIVER=bullmq` + `REDIS_URL` to run them through BullMQ instead.

Installable / offline PWA (the service worker only exists in a build):

```bash
npm run build -w @rtm/web && npm run preview -w @rtm/web
```

then open http://localhost:4173.

## Demo logins

All seeded accounts use password **`Rcpl@1234`** (demo data only). The login page has one-click buttons.

| Role | Email | Notes |
|---|---|---|
| DSR | `dsr.ravi@rcpl.test` | Mumbai, has a van. Others: `dsr.sunil@`, `dsr.hetal@`, `dsr.aman@`, `dsr.kavya@` |
| Distributor | `dist.mh01@rcpl.test` | also `dist.gj01@`, `dist.dl01@`, `dist.ka01@` |
| HQ / managers | `hq@rcpl.test`, `rsm.west@`, `asm.mumbai@` … | **MFA**: enrol on first login. With `DEMO_MODE=1` the login screen shows the current code |
| Retailer (eB2B) | `retailer.gt@`, `retailer.mt@`, `retailer.ecom@`, `retailer.qcom@`, `retailer.horeca@` | accepts the privacy notice on first use |
| Admin | `admin@rcpl.test` | MFA as above |

Trading-partner intake (MT / e-com / q-com): `POST /api/integrations/orders/<PARTNER>` with `X-Partner-Key: <partner>-demo-key` and `X-Partner-Signature: hex(HMAC-SHA256(body, "<partner>-demo-secret"))`, partners `STAR-HYPER`, `SHOPKART`, `ZIPMART` (lower-case in the key/secret). Admin → *Schemes, partners, privacy → Trading partners* lets you send payloads through the same adapter without credentials.

## Demo script

1. **DSR offline visit** (`dsr.ravi`, phone-size window): *Settings → Airplane mode* on → *Check in* → *Gupta Super Mart → Take order* (device prices it: margin, quantity slab, free goods, value slab, GST) → *Collect payment* cash or cheque → *Sync queue* shows items waiting → airplane mode off → all **Synced** → *Replay synced items* returns **DUPLICATE** for each, so nothing is created twice.
2. **Distributor** (`dist.mh01`): open the order → *Fulfil & invoice* (FEFO; near-expiry batches held back) → IRN appears within seconds (e-way bill too above ₹50,000) → *Mark delivered*. *Receipts* (cheques: deposit / cleared / bounced; refunds), *Cash & bank* (statement import auto-matches deposits, cheques, transfers; the rest goes to the exception queue), *Credit* (ageing; request a limit change), *Claims* (validated against invoiced secondary sales).
3. **Retailer eB2B** (`retailer.gt`): accept the privacy notice → *Shop* (offers applied on the device) → **Pay now** → checkout: *Simulate bank decline* then *Pay with UPI* → the signed gateway webhook confirms the order. Also try **Cash on delivery** (distributor collects at the door) and **Khata** (credit). *Dues & payments* → pay outstanding online. *Privacy* → download data, withdraw consents, request erasure.
4. **HQ** (`hq`, MFA): *Overview*, *Distribution & KPIs* (numeric / weighted distribution, strike rate, pipeline gap, scheme ROI, ageing), *Approvals* (scheme activation, credit limits, claims by level and territory), *Claims*, *Exceptions*, *Audit trail*.
5. **Admin** (`admin`, MFA): master data CRUD + CSV bulk import (dry run first), price revisions as dated versions, new channels / RTM models, schemes (draft, then request activation), partners, integrations and jobs, privacy requests.

## Tests

```bash
npm test
```

- `packages/shared`: 21 unit tests (pricing, all scheme types, GST, GSTIN, routing, state machine, master-data schemas, CSV).
- `apps/api`: 50 end-to-end tests against a real Postgres (`TEST_DATABASE_URL`, rebuilt each run): sync idempotency incl. concurrent retries, price-changed-offline, credit holds, ledger balance and immutability at the DB, cancellations and returns, master data and import, online payments and webhooks, COD, cash deposit variance, bank recon, cheque bounce auto-block, UPI verification, IRN / e-way bill, claims (validation, de-dup, inflation), scheme budget / correction / cashback, partner intake, MFA, approvals, DPDP, KPIs, integrations.

## Guarantees enforced in the database

See `apps/api/prisma/migrations/*`:
- `AuditLog`, `Journal`, `LedgerEntry`, `StockMovement`, `SecondarySale`, `SchemeUsage`, `Consent` reject UPDATE / DELETE (and TRUNCATE for the ledger/audit set).
- Every journal balances (deferred constraint trigger at commit); ledger lines are one-sided; stock can't go negative; claim approvals can't exceed validated amounts.
- Idempotency: sync keys, partner order refs, gateway event ids and payment ids are unique.

## Production notes (not done here)

India data residency: deploy Postgres, Redis and the API in an Indian region (e.g. Mumbai), backups included. Use TLS everywhere and turn on encryption at rest (managed-disk / RDS encryption). Real Razorpay keys go in env and never in the repo; card data never reaches this system (hosted checkout). Unset `DEMO_MODE`. Swap the mock GST, ERP, 3PL and marketplace connectors for real ones (same interfaces).
