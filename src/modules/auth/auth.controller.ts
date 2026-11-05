import {
  Controller,
  Post,
  Get,
  Body,
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
      portal?: 'customer' | 'admin';
    },
  ) {
    return this.authService.login(body);
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
  async getAdminStats(@Headers('authorization') authHeader?: string) {
    return this.authService.getAdminStats(authHeader);
  }
}
