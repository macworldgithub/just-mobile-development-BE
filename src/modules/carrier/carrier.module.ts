import { Module, forwardRef } from '@nestjs/common';
import { CarrierService } from './carrier.service';
import { CarrierController } from './carrier.controller';
import { InvoiceService } from './invoice.service';
import { CarrierPortingWorker } from './carrier-porting.worker';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [CarrierController],
  providers: [CarrierService, InvoiceService, CarrierPortingWorker],
  exports: [CarrierService, InvoiceService, CarrierPortingWorker],
})
export class CarrierModule {}
