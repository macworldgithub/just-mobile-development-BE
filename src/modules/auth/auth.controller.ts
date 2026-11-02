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
      name: string;
      email: string;
      password?: string;
      phone?: string;
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
      email: string;
      password?: string;
      code?: string;
      portal?: 'customer' | 'admin';
    },
  ) {
    return this.authService.login(body);
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
