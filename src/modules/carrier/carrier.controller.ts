import { Controller, Post, Get, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { CarrierService } from './carrier.service';
import type { CarrierCustomerInput, ActivateOrderInput, ActivatePortOrderInput } from './carrier.service';

@Controller('api/carrier')
export class CarrierController {
  constructor(private readonly carrierService: CarrierService) {}

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
  // ORDER ACTIVATION ENDPOINTS
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

  // ==========================================================================
  // ESIM DIGITAL QR CODE ENDPOINTS
  // ==========================================================================

  @Get('qrcodes/:identifier')
  async getEsimQRCode(@Param('identifier') identifier: string) {
    return this.carrierService.getEsimQRCode(identifier);
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
