import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CarrierService } from '../carrier/carrier.service';

interface CanonicalPlanDefinition {
  id: string;
  planNo: number;
  name: string;
  tier: string;
  dataGb: number;
  pricePerMonth: number;
  description: string;
  fit: string;
  network: '4G' | '5G';
  popular: boolean;
  badgeText: string;
  roamingInternationalMinutes: boolean;
  features: string[];
  active: boolean;
  displayOrder: number;
}

const CANONICAL_PLANS: CanonicalPlanDefinition[] = [
  {
    id: 'plan-15gb',
    planNo: 11144154,
    name: 'JM 15GB Auto',
    tier: '15GB',
    dataGb: 15,
    pricePerMonth: 31,
    description: 'Great everyday data for light browsing and socials.',
    fit: 'Casual Browsing',
    network: '4G',
    popular: false,
    badgeText: '4G · SIM-only',
    roamingInternationalMinutes: false,
    features: [
      '15GB high-speed 4G monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 4G Network coverage',
      'Zero bill shock · data stops when cap reached',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 1,
  },
  {
    id: 'plan-45gb',
    planNo: 11144156,
    name: 'JM 45GB Auto',
    tier: '45GB',
    dataGb: 45,
    pricePerMonth: 36,
    description: 'Fast 5G everyday data with international calls included.',
    fit: 'Everyday 5G',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '45GB superfast 5G monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'Zero bill shock · data stops when cap reached',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 2,
  },
  {
    id: 'plan-65gb',
    planNo: 11144157,
    name: 'JM 65GB Auto',
    tier: '65GB',
    dataGb: 65,
    pricePerMonth: 40,
    description: 'Our sweet spot 5G plan with generous high-speed data.',
    fit: 'Streaming & Video',
    network: '5G',
    popular: true,
    badgeText: 'Our sweet spot ↗',
    roamingInternationalMinutes: true,
    features: [
      '65GB superfast 5G monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'Zero bill shock · data stops when cap reached',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 3,
  },
  {
    id: 'plan-100gb',
    planNo: 11144168,
    name: 'JM 100GB Auto',
    tier: '100GB',
    dataGb: 100,
    pricePerMonth: 48,
    description: 'For life in full stream, hot-spotting, and high-definition video.',
    fit: 'Power Users & Hotspot',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '100GB uncapped 5G maximum speed monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'Zero bill shock · data stops when cap reached',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 4,
  },
  {
    id: 'plan-120gb',
    planNo: 11144169,
    name: 'JM 120GB Auto',
    tier: '120GB',
    dataGb: 120,
    pricePerMonth: 57,
    description: 'High allowance 5G data for hot-spotting, work, and travel.',
    fit: 'Work from Anywhere',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '120GB uncapped 5G maximum speed monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'Zero bill shock · data stops when cap reached',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 5,
  },
  {
    id: 'plan-150gb',
    planNo: 11144170,
    name: 'JM 150GB Auto',
    tier: '150GB',
    dataGb: 150,
    pricePerMonth: 62,
    description: 'Pro data package for heavy downloads, gaming, and remote work.',
    fit: 'Heavy Media & Creators',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '150GB uncapped 5G maximum speed monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'Zero bill shock · data stops when cap reached',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 6,
  },
  {
    id: 'plan-180gb',
    planNo: 11156014,
    name: 'JM 180GB Auto',
    tier: '180GB',
    dataGb: 180,
    pricePerMonth: 67,
    description: 'Maximum power 5G data with total freedom to stream and share.',
    fit: 'Ultimate Freedom',
    network: '5G',
    popular: false,
    badgeText: '5G · SIM-only',
    roamingInternationalMinutes: true,
    features: [
      '180GB uncapped 5G maximum speed monthly data',
      'Unlimited standard calls & SMS within Australia',
      'Unlimited standard calls to 15 international countries',
      'Priority Australian support queue',
      'Instant eSIM QR code delivery or physical SIM',
      'Telstra Wholesale 5G Network coverage',
      'No lock-in contract · Cancel anytime',
    ],
    active: true,
    displayOrder: 7,
  },
];

const CANONICAL_PLAN_IDS = CANONICAL_PLANS.map((p) => p.id);

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);
  private readonly cacheTtlMs = 60_000;
  private cachedResult: { source: string; data: any[] } | null = null;
  private cacheExpiresAt = 0;
  private reconciled = false;

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(forwardRef(() => CarrierService))
    private readonly carrierService: CarrierService,
  ) {}

  private async ensureCanonicalPlansSynced(col: any): Promise<void> {
    if (this.reconciled) return;
    try {
      const now = new Date();
      await col.updateMany(
        { id: { $nin: CANONICAL_PLAN_IDS } },
        { $set: { active: false, updatedAt: now } },
      );
      for (const plan of CANONICAL_PLANS) {
        await col.updateOne(
          { id: plan.id },
          { $set: { ...plan, updatedAt: now }, $setOnInsert: { createdAt: now } },
          { upsert: true },
        );
      }
      this.reconciled = true;
    } catch (err: any) {
      this.logger.warn(`Unable to persist canonical plans to MongoDB (using canonical fallback): ${err.message}`);
    }
  }

  async getAllPlans(): Promise<{ source: string; data: any[] }> {
    if (this.cachedResult && Date.now() < this.cacheExpiresAt) {
      return this.cachedResult;
    }
    try {
      let col: any = null;
      let source = 'canonical-backend';
      let basePlans: any[] = CANONICAL_PLANS.map((p) => ({ ...p }));

      try {
        col = this.dbService.getCollection('plans');
        await this.ensureCanonicalPlansSynced(col);
        const dbPlans = await col
          .find({ id: { $in: CANONICAL_PLAN_IDS }, active: true })
          .sort({ displayOrder: 1 })
          .toArray();
        if (dbPlans.length === CANONICAL_PLANS.length) {
          source = 'mongodb-backend';
          const canonicalById = new Map(CANONICAL_PLANS.map((p) => [p.id, p]));
          basePlans = dbPlans.map((mp: any) => ({
            ...mp,
            ...(canonicalById.get(mp.id) || {}),
          }));
        }
      } catch (dbErr: any) {
        this.logger.warn(`MongoDB plans query fallback to canonical list: ${dbErr.message}`);
      }

      let mergedPlans = basePlans;

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
            for (const mp of basePlans) {
              const liveMatch = octaneByTier.get(String(mp.tier || '').toUpperCase());
              if (liveMatch) {
                if (col && mp._id && Number(mp.planNo) !== Number(liveMatch.planNo)) {
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
