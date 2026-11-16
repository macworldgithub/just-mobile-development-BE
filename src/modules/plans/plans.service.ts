import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CarrierService } from '../carrier/carrier.service';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);
  private readonly cacheTtlMs = 60_000;
  private cachedResult: { source: string; data: any[] } | null = null;
  private cacheExpiresAt = 0;

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(forwardRef(() => CarrierService))
    private readonly carrierService: CarrierService,
  ) {}

  async getAllPlans(): Promise<{ source: string; data: any[] }> {
    if (this.cachedResult && Date.now() < this.cacheExpiresAt) {
      return this.cachedResult;
    }
    try {
      const col = this.dbService.getCollection('plans');
      const mongoPlans = await col
        .find({ active: true })
        .sort({ displayOrder: 1 })
        .toArray();

      let source = 'mongodb-backend';
      let mergedPlans = mongoPlans;

      if (process.env.TELCO_LIVE_CREATE === 'true') {
        try {
          const octanePlans = await this.carrierService.getGroupPlans();
          if (octanePlans.length > 0) {
            source = 'octane-live';
            const octaneByTier = new Map<string, any>();
            for (const op of octanePlans) {
              const nameLower = String(op.planName || '').toLowerCase();
              if (!nameLower.startsWith('jm ')) continue;
              const gbMatch = nameLower.match(/(\d+)\s*gb/);
              if (gbMatch) {
                octaneByTier.set(`${gbMatch[1]}GB`, op);
              }
            }

            mergedPlans = [];
            for (const mp of mongoPlans) {
              const liveMatch = octaneByTier.get(String(mp.tier || '').toUpperCase());
              if (liveMatch) {
                if (Number(mp.planNo) !== Number(liveMatch.planNo)) {
                  await col
                    .updateOne({ _id: mp._id }, { $set: { planNo: Number(liveMatch.planNo), updatedAt: new Date() } })
                    .catch(() => {});
                }
                mergedPlans.push({
                  ...mp,
                  planNo: Number(liveMatch.planNo),
                  octanePlanName: liveMatch.planName,
                  usageType: liveMatch.usageType || 'MB',
                  syncedWithOctane: true,
                });
              } else {
                mergedPlans.push({ ...mp, syncedWithOctane: false });
              }
            }
          }
        } catch (err: any) {
          this.logger.warn(`Octane getGroupPlans fallback to MongoDB: ${err.message}`);
        }
      }

      this.cachedResult = { source, data: mergedPlans };
      this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
      return this.cachedResult;
    } catch (err) {
      this.logger.error('Failed to query plans:', err);
      throw err;
    }
  }

  async getPlanById(id: string) {
    const all = await this.getAllPlans();
    return all.data.find((p) => p.id === id || String(p.planNo) === String(id)) || null;
  }
}
