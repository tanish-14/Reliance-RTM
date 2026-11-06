import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma.service';

/** Indian financial year label, e.g. 2026-11-03 -> "2627". */
export function financialYear(d: Date): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`;
}

/** Gap-free document numbers (GST invoices must be consecutive and ≤ 16 chars). */
@Injectable()
export class SequenceService {
  async next(tx: Tx, tenantId: string, scope: string): Promise<number> {
    const rows = await tx.$queryRaw<{ n: number }[]>`
      INSERT INTO "DocSequence" (id, "tenantId", scope, next)
      VALUES (gen_random_uuid()::text, ${tenantId}, ${scope}, 2)
      ON CONFLICT ("tenantId", scope) DO UPDATE SET next = "DocSequence".next + 1
      RETURNING next - 1 AS n`;
    return Number(rows[0].n);
  }

  /** GST invoice: per supplier per FY, e.g. MH01/2627/000123 (16 chars). */
  async invoiceNo(tx: Tx, tenantId: string, distCode: string, at = new Date()) {
    const fy = financialYear(at);
    return `${distCode}/${fy}/${pad(await this.next(tx, tenantId, `INV:${distCode}:${fy}`), 6)}`;
  }

  /** Credit note: per supplier per FY, e.g. MH01/CN2627/0001 (16 chars). */
  async creditNoteNo(tx: Tx, tenantId: string, distCode: string, at = new Date()) {
    const fy = financialYear(at);
    return `${distCode}/CN${fy}/${pad(await this.next(tx, tenantId, `CN:${distCode}:${fy}`), 4)}`;
  }

  /** Debit note: per supplier per FY, e.g. MH01/DN2627/0001 (16 chars). */
  async debitNoteNo(tx: Tx, tenantId: string, distCode: string, at = new Date()) {
    const fy = financialYear(at);
    return `${distCode}/DN${fy}/${pad(await this.next(tx, tenantId, `DN:${distCode}:${fy}`), 4)}`;
  }

  /** Tenant-wide operational numbers: SO2627-000001, RT2627-00001, RC2627-000001. */
  async opNo(tx: Tx, tenantId: string, kind: 'SO' | 'RT' | 'RC', at = new Date()) {
    const fy = financialYear(at);
    return `${kind}${fy}-${pad(await this.next(tx, tenantId, `${kind}:${fy}`), kind === 'RT' ? 5 : 6)}`;
  }
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');
