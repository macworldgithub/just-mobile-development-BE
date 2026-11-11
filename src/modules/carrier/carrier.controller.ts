import { Controller, Post, Get, Param, Body, Query, Res, HttpCode, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { CarrierService } from './carrier.service';
import { InvoiceService } from './invoice.service';
import { CarrierPortingWorker } from './carrier-porting.worker';
import type { CarrierCustomerInput, ActivateOrderInput, ActivatePortOrderInput } from './carrier.service';

@Controller('api/carrier')
export class CarrierController {
  constructor(
    private readonly carrierService: CarrierService,
    private readonly invoiceService: InvoiceService,
    private readonly portingWorker: CarrierPortingWorker,
  ) {}

  // ==========================================================================
  // CUSTOMER ENDPOINTS
  // ==========================================================================

  @Post('customers')
  @HttpCode(HttpStatus.CREATED)
  async addCustomer(@Body() body: Record<string, any>) {
    return this.carrierService.addCustomer(body as CarrierCustomerInput);
  }

  @Get('customers/:custNo')
  async getCustomer(@Param('custNo') custNo: string) {
    return this.carrierService.getCustomer(custNo);
  }

  @Get('customers/:custNo/services')
  async getServices(@Param('custNo') custNo: string) {
    return this.carrierService.getServices(custNo);
  }

  @Get('customers/:custNo/balance')
  async getBalance(@Param('custNo') custNo: string) {
    return this.carrierService.getBalance(custNo);
  }

  @Get('customers/:custNo/usage')
  async getUsage(@Param('custNo') custNo: string) {
    return this.carrierService.getUnbilledUsage(custNo);
  }

  @Get('customers/:custNo/orders')
  async getCustomerOrders(@Param('custNo') custNo: string) {
    return this.carrierService.getCustomerOrders(custNo);
  }

  @Post('customers/:custNo/change-plan')
  @HttpCode(HttpStatus.OK)
  async changePlan(
    @Param('custNo') custNo: string,
    @Body()
    body: {
      planId?: string;
      planName: string;
      monthlyFee: number;
      dataGb: number;
      dataBankMaxGb?: number;
      msn?: string;
    },
  ) {
    return this.carrierService.changePlan(custNo, body);
  }

  // ==========================================================================
  // TAX INVOICE ENDPOINTS (INT-08)
  // ==========================================================================

  @Get('customers/:custNo/invoices')
  async getCustomerInvoices(@Param('custNo') custNo: string) {
    return this.invoiceService.getCustomerInvoices(custNo);
  }

  @Get('customers/:custNo/invoices/:invoiceId/pdf')
  async downloadInvoicePdf(
    @Param('custNo') custNo: string,
    @Param('invoiceId') invoiceId: string,
    @Res() res: Response,
  ) {
    const pdfBuffer = await this.invoiceService.generateTaxInvoicePdf(custNo, invoiceId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="JustMobile-Tax-Invoice-${invoiceId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  }

  // ==========================================================================
  // NUMBER RESERVATION ENDPOINTS
  // ==========================================================================

  @Get('numbers/reserve')
  async reserveNumbers(@Query('qty') qty?: string) {
    const count = qty ? parseInt(qty, 10) : 5;
    return this.carrierService.reserveNumbers(isNaN(count) ? 5 : count);
  }

  @Get('numbers/check')
  async checkNumber(@Query('number') number: string) {
    return this.carrierService.checkNumber(number || '');
  }

  // ==========================================================================
  // ORDER ACTIVATION & PORTING WORKER ENDPOINTS (INT-10)
  // ==========================================================================

  @Post('orders/activate')
  @HttpCode(HttpStatus.CREATED)
  async activateNewOrder(@Body() body: Record<string, any>) {
    return this.carrierService.activateNewOrder(body as ActivateOrderInput);
  }

  @Post('orders/activate-port')
  @HttpCode(HttpStatus.CREATED)
  async activatePortOrder(@Body() body: Record<string, any>) {
    return this.carrierService.activatePortOrder(body as ActivatePortOrderInput);
  }

  @Get('orders/:orderId')
  async queryOrder(@Param('orderId') orderId: string) {
    return this.carrierService.queryOrder(orderId);
  }

  @Post('orders/:orderId/sync-port')
  @HttpCode(HttpStatus.OK)
  async syncPortOrder(@Param('orderId') orderId: string) {
    return this.portingWorker.forceSyncOrder(orderId);
  }

  // ==========================================================================
  // ESIM DIGITAL QR CODE ENDPOINTS
  // ==========================================================================

  @Get('qrcodes/:identifier')
  async getEsimQRCode(@Param('identifier') identifier: string) {
    return this.carrierService.getEsimQRCode(identifier);
  }

  @Post('customers/:custNo/orders/:orderId/send-esim-email')
  @HttpCode(HttpStatus.OK)
  async sendOrderEsimEmail(
    @Param('custNo') custNo: string,
    @Param('orderId') orderId: string,
    @Body() body?: { email?: string },
  ) {
    return this.carrierService.sendOrderEsimEmail(custNo, orderId, body?.email);
  }

  // ==========================================================================
  // ACMA PRE-PORT 2FA SMS ENDPOINTS
  // ==========================================================================

  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() body: { custNo: string; destination: string }) {
    return this.carrierService.sendPrePortOtp(body.custNo, body.destination);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() body: { transactionId: string; code: string }) {
    return this.carrierService.verifyPrePortOtp(body.transactionId, body.code);
  }
}
