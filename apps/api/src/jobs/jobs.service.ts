import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { PrismaService, type Tx } from '../prisma.service';
import { toJson } from '../common/json';

export type JobHandler = (payload: any, job: Job) => Promise<unknown>;

/** Throw from a handler for failures that retrying cannot fix (e.g. invalid GST data). */
export class PermanentJobError extends Error {}

/**
 * Background jobs with a transactional outbox.
 *
 * `enqueue(tx, …)` writes a Job row in the *same* transaction as the business change, so a job
 * exists iff the change committed. Execution drivers (QUEUE_DRIVER):
 *  - `pg` (default): workers claim rows with FOR UPDATE SKIP LOCKED — safe with many API instances.
 *  - `bullmq`: rows are relayed into BullMQ on REDIS_URL and BullMQ workers execute them.
 *  - `inline`: nothing runs automatically; tests call `drain()`.
 * Failures retry with exponential backoff; dedupe keys make enqueue idempotent.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobsService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules: { name: string; everyMs: number }[] = [];
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;
  private bull: { queue: any; worker: any } | null = null;
  readonly driver = (process.env.QUEUE_DRIVER ?? 'pg') as 'pg' | 'bullmq' | 'inline';

  constructor(private readonly prisma: PrismaService) {}

  register(name: string, handler: JobHandler) {
    this.handlers.set(name, handler);
  }

  /** Periodic job; the time-slot dedupe key keeps multiple API instances from double-scheduling. */
  every(name: string, everyMs: number) {
    this.schedules.push({ name, everyMs });
  }

  async enqueue(tx: Tx, name: string, payload: unknown, opts: { key?: string; delayMs?: number; tenantId?: string; maxAttempts?: number } = {}) {
    await tx.job.createMany({
      data: [
        {
          name,
          payload: toJson(payload ?? {}),
          key: opts.key ?? null,
          tenantId: opts.tenantId ?? null,
          runAt: new Date(Date.now() + (opts.delayMs ?? 0)),
          maxAttempts: opts.maxAttempts ?? 8,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** Claim and run due jobs once. Returns how many ran. */
  async runDue(limit = 20): Promise<number> {
    // Reclaim jobs whose worker died mid-run.
    await this.prisma.$executeRaw`UPDATE "Job" SET status = 'PENDING', "lockedAt" = NULL
      WHERE status = 'RUNNING' AND "lockedAt" < now() - interval '5 minutes'`;
    const jobs = await this.prisma.$queryRaw<Job[]>`
      UPDATE "Job" SET status = 'RUNNING', "lockedAt" = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM "Job" WHERE status = 'PENDING' AND "runAt" <= now()
        ORDER BY "runAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) RETURNING *`;
    for (const job of jobs) await this.execute(job);
    return jobs.length;
  }

  /** Run until the queue is quiet (tests, admin "run now"). Schedules fire once first. */
  async drain(rounds = 20) {
    await this.fireSchedules(true);
    let total = 0;
    for (let i = 0; i < rounds; i++) {
      const n = await this.runDue(50);
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  private async execute(job: Job) {
    const handler = this.handlers.get(job.name);
    try {
      if (!handler) throw new PermanentJobError(`No handler for ${job.name}`);
      await handler(job.payload, job);
      await this.prisma.job.update({ where: { id: job.id }, data: { status: 'DONE', doneAt: new Date(), lockedAt: null, lastError: null } });
    } catch (e) {
      const permanent = e instanceof PermanentJobError || job.attempts >= job.maxAttempts;
      const backoffMs = Math.min(3_600_000, 5_000 * 2 ** (job.attempts - 1));
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: permanent ? 'FAILED' : 'PENDING', lockedAt: null, lastError: String((e as Error).message).slice(0, 1000), runAt: new Date(Date.now() + backoffMs) },
      });
      if (permanent) this.log.error({ job: job.name, id: job.id, err: (e as Error).message }, 'job failed permanently');
    }
  }

  private async fireSchedules(force = false) {
    for (const s of this.schedules) {
      const slot = Math.floor(Date.now() / s.everyMs);
      await this.enqueue(this.prisma, s.name, {}, { key: force ? undefined : `${s.name}@${slot}` });
    }
  }

  async onApplicationBootstrap() {
    if (this.driver === 'inline') return;
    if (this.driver === 'bullmq') await this.startBull();
    const tick = async () => {
      if (this.ticking) return;
      this.ticking = true;
      try {
        if (this.driver === 'bullmq') await this.relayToBull();
        else while ((await this.runDue()) > 0);
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'job tick failed');
      } finally {
        this.ticking = false;
      }
    };
    this.timers.push(setInterval(() => void tick(), 1_000));
    for (const s of this.schedules) {
      this.timers.push(setInterval(() => void this.fireSchedules().catch(() => undefined), Math.min(s.everyMs, 60_000)));
    }
  }

  async onModuleDestroy() {
    this.timers.forEach(clearInterval);
    await this.bull?.worker.close();
    await this.bull?.queue.close();
  }

  // --- BullMQ driver (requires REDIS_URL; not exercised on the dev machine — see PROGRESS.md) ---
  private async startBull() {
    const { Queue, Worker } = await import('bullmq');
    const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };
    const queue = new Queue('rtm', { connection });
    const worker = new Worker(
      'rtm',
      async (bj) => {
        const job = await this.prisma.job.update({ where: { id: bj.data.jobId }, data: { status: 'RUNNING', lockedAt: new Date(), attempts: { increment: 1 } } });
        await this.execute(job);
        const after = await this.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        if (after.status === 'PENDING') {
          await this.prisma.job.update({ where: { id: job.id }, data: { status: 'DISPATCHED' } });
          await queue.add(job.name, { jobId: job.id }, { delay: Math.max(0, after.runAt.getTime() - Date.now()), jobId: `${job.id}:${after.attempts}` });
        }
      },
      { connection, concurrency: 5 },
    );
    this.bull = { queue, worker };
  }

  private async relayToBull() {
    const due = await this.prisma.$queryRaw<Job[]>`
      UPDATE "Job" SET status = 'DISPATCHED' WHERE id IN (
        SELECT id FROM "Job" WHERE status = 'PENDING' AND "runAt" <= now() LIMIT 100 FOR UPDATE SKIP LOCKED
      ) RETURNING *`;
    for (const j of due) await this.bull!.queue.add(j.name, { jobId: j.id }, { jobId: `${j.id}:${j.attempts}` });
  }
}
