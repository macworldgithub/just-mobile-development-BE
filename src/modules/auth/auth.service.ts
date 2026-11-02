import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

export interface UserDocument {
  _id?: ObjectId;
  name: string;
  email: string;
  passwordHash?: string;
  phone?: string;
  role: 'customer' | 'admin';
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

export interface VerificationDocument {
  _id?: ObjectId;
  email: string;
  code: string;
  type: 'signup' | 'login' | 'reset';
  expiresAt: Date;
  used: boolean;
  createdAt: Date;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret = process.env.JWT_SECRET || 'justmobile_super_secret_jwt_key_2026';

  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
  ) {}

  async onModuleInit() {
    await this.seedDefaultAdmin();
  }

  private async seedDefaultAdmin() {
    try {
      const usersCol = this.db.getCollection<UserDocument>('users');
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@justmobile.com.au';
      const existingAdmin = await usersCol.findOne({ email: adminEmail });

      if (!existingAdmin) {
        const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
        if (!initialPassword) {
          this.logger.log('ADMIN_INITIAL_PASSWORD not defined in environment; skipping admin seeding.');
          return;
        }
        const passwordHash = await bcrypt.hash(initialPassword, 10);
        await usersCol.insertOne({
          name: 'JustMobile Administrator',
          email: adminEmail,
          passwordHash,
          phone: '0488000000',
          role: 'admin',
          isEmailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        this.logger.log(`✓ Seeded default admin user (${adminEmail})`);
      }
    } catch (err: any) {
      this.logger.warn(`Could not seed default admin: ${err.message}`);
    }
  }

  async sendVerificationCode(emailRaw: string, type: 'signup' | 'login' = 'signup') {
    const email = emailRaw.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new BadRequestException('A valid email address is required.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const existingUser = await usersCol.findOne({ email });

    if (type === 'signup' && existingUser && existingUser.isEmailVerified) {
      throw new ConflictException('An account with this email already exists. Please log in.');
    }

    if (type === 'login' && !existingUser) {
      throw new NotFoundException('No account found with this email. Please sign up first.');
    }

    // Generate secure 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
    await verificationsCol.insertOne({
      email,
      code,
      type,
      expiresAt,
      used: false,
      createdAt: new Date(),
    });

    // Send code via Hostinger SMTP
    await this.mailService.sendVerificationCode(email, code, existingUser?.name);

    return {
      success: true,
      message: `A 6-digit verification code has been sent to ${email}.`,
    };
  }

  async signup(dto: {
    name: string;
    email: string;
    password?: string;
    phone?: string;
    code: string;
  }) {
    const email = dto.email.trim().toLowerCase();
    const { name, password, phone, code } = dto;

    if (!name || name.trim().length < 2) {
      throw new BadRequestException('Please provide your full name.');
    }
    if (!email || !email.includes('@')) {
      throw new BadRequestException('Please provide a valid email.');
    }
    if (!code || code.trim().length !== 6) {
      throw new BadRequestException('A valid 6-digit verification code is required.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const existingUser = await usersCol.findOne({ email });
    if (existingUser && existingUser.isEmailVerified) {
      throw new ConflictException('An account with this email already exists. Please log in.');
    }

    // Verify OTP
    const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
    const verification = await verificationsCol.findOne({
      email,
      code: code.trim(),
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!verification) {
      throw new BadRequestException('Invalid or expired verification code. Please request a new one.');
    }

    // Mark code as used
    await verificationsCol.updateOne({ _id: verification._id }, { $set: { used: true } });

    let passwordHash: string | undefined;
    if (password && password.length >= 6) {
      passwordHash = await bcrypt.hash(password, 10);
    } else {
      throw new BadRequestException('Password must be at least 6 characters long.');
    }

    const now = new Date();
    const newUser: UserDocument = {
      name: name.trim(),
      email,
      passwordHash,
      phone: phone?.trim() || '',
      role: 'customer',
      isEmailVerified: true,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };

    const insertResult = await usersCol.insertOne(newUser);
    const userId = insertResult.insertedId.toString();

    const token = jwt.sign(
      { sub: userId, email: newUser.email, role: newUser.role, name: newUser.name },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    return {
      success: true,
      message: 'Account created and verified successfully.',
      token,
      user: {
        id: userId,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
      },
    };
  }

  async login(dto: {
    email: string;
    password?: string;
    code?: string;
    portal?: 'customer' | 'admin';
  }) {
    const email = dto.email.trim().toLowerCase();
    const portal = dto.portal || 'customer';

    if (!email) {
      throw new BadRequestException('Email address is required.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const user = await usersCol.findOne({ email });

    if (!user) {
      if (portal === 'admin') {
        throw new UnauthorizedException('Invalid credentials.');
      }
      throw new NotFoundException('Account not found with this email. Please sign up.');
    }

    // Role check for Admin Portal
    if (portal === 'admin' && user.role !== 'admin') {
      throw new UnauthorizedException(
        'Access denied. Administrator privileges are required to access the JustMobile Admin Portal.',
      );
    }

    // Validate either Code or Password
    if (dto.code) {
      const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
      const verification = await verificationsCol.findOne({
        email,
        code: dto.code.trim(),
        used: false,
        expiresAt: { $gt: new Date() },
      });

      if (!verification) {
        throw new BadRequestException('Invalid or expired email verification code.');
      }
      await verificationsCol.updateOne({ _id: verification._id }, { $set: { used: true } });
    } else if (dto.password) {
      if (!user.passwordHash) {
        throw new BadRequestException('No password set for this account. Please log in with email code.');
      }
      const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
      if (!isMatch) {
        throw new UnauthorizedException('Incorrect password.');
      }
    } else {
      throw new BadRequestException('Please provide your password or verification code.');
    }

    // Update lastLoginAt
    await usersCol.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    const userId = user._id!.toString();
    const token = jwt.sign(
      { sub: userId, email: user.email, role: user.role, name: user.name },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    return {
      success: true,
      message: `Successfully logged in to ${portal === 'admin' ? 'Admin Portal' : 'Customer Portal'}.`,
      token,
      user: {
        id: userId,
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        role: user.role,
      },
    };
  }

  async getMe(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization header is required.');
    }

    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as any;
      const usersCol = this.db.getCollection<UserDocument>('users');
      const user = await usersCol.findOne({ _id: new ObjectId(decoded.sub) });

      if (!user) {
        throw new UnauthorizedException('User no longer exists.');
      }

      return {
        success: true,
        user: {
          id: user._id!.toString(),
          name: user.name,
          email: user.email,
          phone: user.phone || '',
          role: user.role,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        },
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session token.');
    }
  }

  async getAdminStats(authHeader?: string) {
    const me = await this.getMe(authHeader);
    if (me.user.role !== 'admin') {
      throw new UnauthorizedException('Admin access required.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const totalUsers = await usersCol.countDocuments();
    const customers = await usersCol
      .find({ role: 'customer' })
      .project({ passwordHash: 0 })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    return {
      success: true,
      stats: {
        totalUsers,
        totalCustomers: customers.length,
        smtpConfigured: Boolean(process.env.SMTP_USER),
        smtpHost: process.env.SMTP_HOST || 'smtp.hostinger.com',
      },
      customers: customers.map((c) => ({
        id: c._id!.toString(),
        name: c.name,
        email: c.email,
        phone: c.phone,
        role: c.role,
        createdAt: c.createdAt,
        lastLoginAt: c.lastLoginAt,
      })),
    };
  }
}
