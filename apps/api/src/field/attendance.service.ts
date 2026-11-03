import { Injectable } from '@nestjs/common';
import { withinGeofence } from '@rtm/shared';
import type { Tx } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { DomainError, notFound } from '../common/errors';
import { ReviewService } from '../core/review.service';
import { ScopeService } from '../core/scope.service';
import { AuditService } from '../core/audit.service';

/**
 * Geo-fenced attendance and outlet visits. A fix outside the fence is recorded and flagged
 * for the manager rather than rejected — the device was offline and can't be argued with.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly review: ReviewService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  async attendance(
    tx: Tx,
    user: AuthUser,
    m: { idempotencyKey: string; capturedAt: string; payload: { kind: 'CHECK_IN' | 'CHECK_OUT'; beatId?: string; lat: number; lng: number; accuracyM?: number } },
  ) {
    const p = m.payload;
    const capturedAt = new Date(m.capturedAt);
    const beat = p.beatId
      ? await tx.beat.findFirst({ where: { id: p.beatId, tenantId: user.tenantId, dsrId: user.userId } })
      : await tx.beat.findFirst({ where: { tenantId: user.tenantId, dsrId: user.userId, daysOfWeek: { has: capturedAt.getDay() } } });
    if (p.beatId && !beat) throw new DomainError('BEAT_NOT_ASSIGNED', 'That beat is not assigned to you', 403);

    const flags: string[] = [];
    let distanceM: number | null = null;
    if (beat) {
      const g = withinGeofence(p, { lat: beat.anchorLat, lng: beat.anchorLng }, beat.geofenceM);
      distanceM = g.distanceM;
      if (!g.inside) flags.push('OUTSIDE_GEOFENCE');
    } else {
      flags.push('NO_BEAT_TODAY');
    }
    const row = await tx.attendance.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        beatId: beat?.id,
        kind: p.kind,
        capturedAt,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
        distanceM,
        flags,
        sourceKey: m.idempotencyKey,
      },
    });
    if (flags.length) {
      await this.review.raise(tx, user.tenantId, {
        kind: 'ATTENDANCE',
        refType: 'Attendance',
        refId: row.id,
        distributorId: beat?.distributorId,
        summary: `${user.name} ${p.kind.replace('_', '-').toLowerCase()} ${flags.join(', ')}${distanceM !== null ? ` (${distanceM} m from beat)` : ''}`,
        details: { distanceM, geofenceM: beat?.geofenceM },
      });
    }
    await this.audit.record(tx, user, `ATTENDANCE_${p.kind}`, 'Attendance', row.id, { after: { flags, distanceM } });
    return { refs: [row.id], flags };
  }

  async visit(
    tx: Tx,
    user: AuthUser,
    m: { idempotencyKey: string; capturedAt: string; payload: { outletId: string; beatId?: string; outcome: string; noOrderReason?: string; lat: number; lng: number } },
  ) {
    const p = m.payload;
    await this.scope.assertOutlet(tx, user, p.outletId);
    const outlet = await tx.outlet.findFirst({ where: { id: p.outletId, tenantId: user.tenantId } });
    if (!outlet) throw notFound('Outlet');
    const g = withinGeofence(p, outlet, outlet.geofenceM);
    const flags = g.inside ? [] : ['OUTSIDE_GEOFENCE'];
    const row = await tx.visit.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        outletId: outlet.id,
        beatId: p.beatId,
        capturedAt: new Date(m.capturedAt),
        lat: p.lat,
        lng: p.lng,
        distanceM: g.distanceM,
        outcome: p.outcome,
        noOrderReason: p.noOrderReason,
        flags,
        sourceKey: m.idempotencyKey,
      },
    });
    if (flags.length) {
      await this.review.raise(tx, user.tenantId, {
        kind: 'VISIT_GEOFENCE',
        refType: 'Visit',
        refId: row.id,
        summary: `${user.name} checked in at ${outlet.name} ${g.distanceM} m away`,
        details: { distanceM: g.distanceM, geofenceM: outlet.geofenceM },
      });
    }
    return { refs: [row.id], flags };
  }
}
