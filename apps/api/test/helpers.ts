import 'reflect-metadata';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { priceOrder, routeLines, type MastersBundle } from '@rtm/shared';

export const PASSWORD = 'Rcpl@1234';
export const prisma = new PrismaClient();

// One app per test file, created once even when the first requests arrive concurrently.
let starting: Promise<INestApplication> | null = null;
export function getApp(): Promise<INestApplication> {
  starting ??= (async () => {
    const { createApp } = await import('../src/app.module');
    const app = await createApp();
    // Listen once: otherwise supertest opens an ephemeral listener per request.
    await app.listen(0);
    return app;
  })();
  return starting;
}
export async function closeApp() {
  const app = await starting;
  starting = null;
  await app?.close();
}

export async function http() {
  return request((await getApp()).getHttpServer());
}

export async function login(email: string): Promise<string> {
  const res = await (await http()).post('/api/auth/login').send({ tenant: 'rcpl', email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.mfaRequired) {
    const v = await (await http()).post('/api/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: res.body.demoCode });
    return v.body.token;
  }
  return res.body.token;
}

export async function get(token: string, path: string) {
  return (await http()).get(`/api${path}`).set('authorization', `Bearer ${token}`);
}
export async function post(token: string, path: string, body: unknown = {}) {
  return (await http()).post(`/api${path}`).set('authorization', `Bearer ${token}`).send(body as object);
}

/** Price exactly as the device would (shared engine over the pulled masters bundle). */
export function deviceTotal(b: MastersBundle, outletId: string, lines: { productId: string; qty: number }[], at = new Date()) {
  const outlet = b.outlets.find((o) => o.id === outletId)!;
  const products = Object.fromEntries(b.products.map((p) => [p.id, p]));
  const { groups } = routeLines(lines, (id) => products[id]?.brandId, outlet.services);
  return groups.reduce(
    (a, g) =>
      a +
      priceOrder({
        at: at.toISOString(),
        outlet: { id: outlet.id, channelCode: outlet.channelCode, stateCode: outlet.stateCode, tier: outlet.tier },
        supplierStateCode: g.service.distributorStateCode,
        products,
        priceLists: b.priceLists,
        marginRules: b.marginRules,
        schemes: b.schemes,
        lines: g.lines,
      }).totalPaise,
    0,
  );
}

export class Device {
  n = 0;
  constructor(
    public token: string,
    public id = `dev-t${Math.random().toString(36).slice(2, 8)}`,
  ) {}
  mutation(type: string, payload: unknown, capturedAt = new Date()) {
    return { idempotencyKey: `${this.id}:${++this.n}`, capturedAt: capturedAt.toISOString(), type, payload };
  }
  async push(mutations: unknown[]) {
    const r = await post(this.token, '/sync/push', { deviceId: this.id, mutations });
    if (r.status !== 200) throw new Error(`push ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.results as { status: string; refs?: string[]; flags?: string[]; error?: { code: string } }[];
  }
}

export async function product(code: string) {
  return prisma.product.findFirstOrThrow({ where: { code } });
}
export async function outletNamed(name: string, dsrEmail = 'dsr.ravi@rcpl.test') {
  const dsr = await prisma.user.findFirstOrThrow({ where: { email: dsrEmail } });
  return prisma.outlet.findFirstOrThrow({ where: { name, beats: { some: { beat: { dsrId: dsr.id } } } } });
}
