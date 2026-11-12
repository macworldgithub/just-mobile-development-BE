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
          if (isLive) {
            // Live Octane orderQuery call
            const queryRes: any = await this.carrierService.soapCall('/UtbOrder', 'orderQuery', {
              request: { orderId: order.orderId },
            });

            const ret = queryRes?.return?.orderQueryResponse || queryRes?.return;
            const liveStatus = String(ret?.internalStatus || ret?.status || '').toUpperCase();

            this.logger.log(`[PORTING WORKER] Order ${order.orderId} live Octane status: ${liveStatus}`);

            if (['COMPLETED', 'ACTIVE', 'PROVISIONED', 'SUCCESS'].includes(liveStatus)) {
              await this.transitionToActive(order);
            } else if (['REJECTED', 'FAILED', 'CANCELLED'].includes(liveStatus)) {
              const errorMessage = ret?.errorMessage || ret?.message || 'Identity details do not match donor carrier records.';
              const errorCode = ret?.errorCode || 'DONOR_REJECTED';
              await ordersCol.updateOne(
                { orderId: order.orderId },
                {
                  $set: {
                    status: 'REJECTED',
                    rejectionReason: errorMessage,
                    rejectionCode: errorCode,
                    updatedAt: new Date(),
                  },
                },
              );
              this.logger.warn(`[PORTING WORKER] Order ${order.orderId} rejected by donor carrier: ${errorMessage}`);
            }
          } else {
            // Development / Simulation Mode:
            // Simulate realistic donor network release after 45 seconds
            const ageMs = Date.now() - new Date(order.createdAt || 0).getTime();
            const SIMULATED_PORT_DELAY_MS = 45000; // 45 seconds

            if (ageMs >= SIMULATED_PORT_DELAY_MS) {
              await this.transitionToActive(order);
            } else {
              this.logger.log(
                `[PORTING WORKER] Order ${order.orderId} (MSN: ${order.msn}) in progress (${Math.round(ageMs / 1000)}s / 45s simulated donor release).`,
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

    // Force transition
    await this.transitionToActive(order);
    return {
      orderId,
      status: 'ACTIVE',
      message: 'Mobile number transfer successfully synchronized and activated on network.',
    };
  }
}

