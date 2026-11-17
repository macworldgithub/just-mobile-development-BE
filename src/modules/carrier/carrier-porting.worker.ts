import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CarrierService } from './carrier.service';
import type { OrderRecord } from './carrier.service';

@Injectable()
export class CarrierPortingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CarrierPortingWorker.name);
  private isRunning = false;
  private intervalRef: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly carrierService: CarrierService,
  ) {}

  onModuleInit() {
    // Run continuous background polling only in persistent server environments (not in serverless lambdas)
    if (!process.env.VERCEL) {
      this.intervalRef = setInterval(() => {
        this.checkPendingPortingOrders().catch((err) =>
          this.logger.error(`Error in porting worker loop: ${err.message}`),
        );
      }, 30000);
    }
  }

  onModuleDestroy() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
    }
  }

  /**
   * Periodic background poller checking in-flight mobile porting orders (INT-10)
   * Runs every 30 seconds to reconcile porting statuses with donor networks / Octane.
   */
  async checkPendingPortingOrders() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const ordersCol = this.db.getCollection<OrderRecord>('orders');
      const pendingOrders = await ordersCol
        .find({
          orderType: 'PORT_IN',
          status: 'PORT_IN_PROGRESS',
        })
        .toArray();

      if (!pendingOrders || pendingOrders.length === 0) {
        return;
      }

      this.logger.log(`[PORTING WORKER] Checking ${pendingOrders.length} in-flight port-in orders...`);

      const isLive = process.env.TELCO_LIVE_CREATE === 'true';

      for (const order of pendingOrders) {
        try {
          const isLiveOrder =
            isLive &&
            /^\d+$/.test(String(order.custNo || '').trim()) &&
            !/^(ORD|PORT|REP)-/i.test(String(order.orderId || ''));

          if (isLiveOrder) {
            const live = await this.carrierService.queryOrder(order.orderId);
            this.logger.log(`[PORTING WORKER] Order ${order.orderId} live Octane status: ${live.status}`);
            if (live.status === 'ACTIVE') {
              await this.transitionToActive(order);
            } else if (live.status === 'REJECTED') {
              this.logger.warn(
                `[PORTING WORKER] Order ${order.orderId} rejected by donor carrier: ${live.rejectionReason || 'Donor rejected'}`,
              );
            }
          } else {
            // Sandbox / Non-live Simulation Mode only:
            const ageMs = Date.now() - new Date(order.createdAt || 0).getTime();
            const SIMULATED_PORT_DELAY_MS = 45000;

            if (ageMs >= SIMULATED_PORT_DELAY_MS) {
              await this.transitionToActive(order);
            } else {
              this.logger.log(
                `[PORTING WORKER] Sandbox order ${order.orderId} (MSN: ${order.msn}) in progress (${Math.round(ageMs / 1000)}s / 45s).`,
              );
            }
          }
        } catch (err: any) {
          this.logger.error(`[PORTING WORKER] Failed to check status for order ${order.orderId}:`, err.message);
        }
      }
    } catch (err: any) {
      this.logger.error('[PORTING WORKER] Fatal error checking pending orders:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Helper to transition a completed port order to ACTIVE in database
   */
  async transitionToActive(order: OrderRecord) {
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const now = new Date();

    await ordersCol.updateOne(
      { orderId: order.orderId },
      {
        $set: {
          status: 'ACTIVE',
          updatedAt: now,
        },
      },
    );

    this.logger.log(
      `✓ [PORTING WORKER] Order ${order.orderId} (MSN: ${order.msn}) donor network port-in confirmed. Service transitioned to ACTIVE.`,
    );

    // Record audit event
    try {
      const auditCol = this.db.getCollection('audit_events');
      await auditCol.insertOne({
        eventType: 'PORT_IN_COMPLETED',
        orderId: order.orderId,
        custNo: order.custNo,
        msn: order.msn,
        details: 'Donor carrier released Australian mobile number. Active on Telstra Wholesale.',
        timestamp: now,
      });
    } catch {
      // Non-critical audit logging
    }
  }

  /**
   * Force manual synchronization for an order on demand
   */
  async forceSyncOrder(orderId: string): Promise<{ orderId: string; status: string; message: string }> {
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const order = await ordersCol.findOne({ orderId });

    if (!order) {
      return { orderId, status: 'NOT_FOUND', message: 'Order not found in database.' };
    }

    if (order.status === 'ACTIVE') {
      return { orderId, status: 'ACTIVE', message: 'Service is already active on Telstra Wholesale.' };
    }

    const isLiveOrder =
      process.env.TELCO_LIVE_CREATE === 'true' &&
      /^\d+$/.test(String(order.custNo || '').trim()) &&
      !/^(ORD|PORT|REP)-/i.test(String(order.orderId || ''));

    if (isLiveOrder) {
      const live = await this.carrierService.queryOrder(order.orderId);
      if (live.status === 'ACTIVE') {
        await this.transitionToActive(order);
        return {
          orderId,
          status: 'ACTIVE',
          message: 'Mobile number transfer confirmed by carrier and activated on network.',
        };
      }
      if (live.status === 'REJECTED') {
        return {
          orderId,
          status: 'REJECTED',
          message: live.rejectionReason || 'Transfer was rejected by the donor carrier. Please update your details and resubmit.',
        };
      }
      return {
        orderId,
        status: live.status,
        message: 'Porting transfer is still being processed by the carrier. Please try again shortly.',
      };
    }

    // Sandbox transition
    await this.transitionToActive(order);
    return {
      orderId,
      status: 'ACTIVE',
      message: 'Mobile number transfer successfully synchronized and activated on network.',
    };
  }
}

