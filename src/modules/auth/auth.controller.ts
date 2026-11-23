import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('send-verification')
  @HttpCode(HttpStatus.OK)
  async sendVerificationCode(
    @Body() body: { email: string; type?: 'signup' | 'login' },
  ) {
    return this.authService.sendVerificationCode(body.email, body.type);
  }

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body()
    body: {
      firstName?: string;
      surname?: string;
      name?: string;
      email: string;
      password?: string;
      phone?: string;
      dob?: string;
      address?: string;
      suburb?: string;
      state?: string;
      postcode?: string;
      custType?: 'R' | 'B';
      company?: string;
      abn?: string;
      code: string;
    },
  ) {
    return this.authService.signup(body);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body()
    body: {
      email?: string;
      custNo?: string;
      identifier?: string;
      password?: string;
      pin?: string;
      code?: string;
      twoFactorCode?: string;
      portal?: 'customer' | 'admin';
    },
  ) {
    return this.authService.login(body);
  }

  @Post('login/verify-2fa')
  @HttpCode(HttpStatus.OK)
  async verifyLoginTwoFactor(
    @Body()
    body: {
      preAuthToken: string;
      code: string;
      method?: 'totp' | 'email';
    },
  ) {
    return this.authService.verifyLoginTwoFactor(body);
  }

  @Post('login/send-email-otp')
  @HttpCode(HttpStatus.OK)
  async sendLoginEmailOtp(@Body() body: { preAuthToken: string }) {
    return this.authService.sendLoginEmailOtp(body.preAuthToken);
  }

  @Get('2fa/status')
  async getTwoFactorStatus(@Headers('authorization') authHeader?: string) {
    return this.authService.getTwoFactorStatus(authHeader);
  }

  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  async setupTwoFactor(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body?: { currentTwoFactorCode?: string; code?: string },
  ) {
    return this.authService.setupTwoFactor(authHeader, body?.currentTwoFactorCode || body?.code);
  }

  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  async enableTwoFactor(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { code: string; currentTwoFactorCode?: string },
  ) {
    return this.authService.enableTwoFactor(authHeader, body.code, body.currentTwoFactorCode);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  async disableTwoFactor(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { code: string },
  ) {
    return this.authService.disableTwoFactor(authHeader, body.code);
  }

  @Post('2fa/send-action-code')
  @HttpCode(HttpStatus.OK)
  async sendActionTwoFactorCode(@Headers('authorization') authHeader?: string) {
    return this.authService.sendActionTwoFactorCode(authHeader);
  }

  @Post('profile/update')
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Headers('authorization') authHeader: string | undefined,
    @Body()
    body: {
      firstName?: string;
      surname?: string;
      preferredName?: string;
      email?: string;
      phone?: string;
      address?: string;
      suburb?: string;
      state?: string;
      postcode?: string;
      postalAddress?: string;
      commPreference?: 'email' | 'sms' | 'both';
      marketingConsent?: boolean;
      twoFactorCode: string;
    },
  ) {
    return this.authService.updateProfile(authHeader, body);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() body: { identifier: string }) {
    return this.authService.forgotPassword(body.identifier);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() body: { identifier: string; code: string; newPassword: string },
  ) {
    return this.authService.resetPassword(body);
  }

  @Get('me')
  async getMe(@Headers('authorization') authHeader?: string) {
    return this.authService.getMe(authHeader);
  }

  @Get('admin/stats')
  async getAdminStats(
    @Headers('authorization') authHeader?: string,
    @Query('refresh') refresh?: string,
  ) {
    const forceRefresh = refresh === 'true' || refresh === '1';
    return this.authService.getAdminStats(authHeader, forceRefresh);
  }

  @Get('admin/support-cases')
  async getAdminSupportCases(@Headers('authorization') authHeader?: string) {
    return this.authService.getAdminSupportCases(authHeader);
  }

  @Post('admin/support-cases/status')
  @HttpCode(HttpStatus.OK)
  async updateAdminSupportCaseStatus(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { collection: string; referenceNumber: string; status: string; adminNote?: string },
  ) {
    return this.authService.updateAdminSupportCaseStatus(authHeader, body);
  }
}
