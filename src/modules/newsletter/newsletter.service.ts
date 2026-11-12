import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { BroadcastDto } from './dto/broadcast.dto';

export interface SubscriberRecord {
  email: string;
  source: string;
  status: 'active' | 'unsubscribed';
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly mailService: MailService,
  ) {}

  private getCollection() {
    return this.databaseService.getCollection<SubscriberRecord>('newsletter_subscribers');
  }

  private getBroadcastsCollection() {
    return this.databaseService.getCollection<any>('newsletter_broadcasts');
  }

  async subscribe(dto: SubscribeDto): Promise<{ success: boolean; message: string }> {
    if (!dto?.email || typeof dto.email !== 'string' || !dto.email.includes('@')) {
      throw new BadRequestException('Please provide a valid email address.');
    }
    const email = dto.email.trim().toLowerCase();
    const source = dto.source || 'homepage_launch_banner';

    const col = this.getCollection();
    const existing = await col.findOne({ email });

    if (existing) {
      if (existing.status === 'unsubscribed') {
        await col.updateOne(
          { email },
          { $set: { status: 'active', updatedAt: new Date() } },
        );
        this.logger.log(`Subscriber reactivated: ${email}`);
        return { success: true, message: 'Welcome back! You have been re-subscribed to updates.' };
      }
      return { success: true, message: 'You are already subscribed to JustMobile updates!' };
    }

    const newRecord: SubscriberRecord = {
      email,
      source,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await col.insertOne(newRecord);
    this.logger.log(`✓ New newsletter subscriber captured: ${email} (source: ${source})`);

    // Send brief welcome confirmation
    this.mailService
      .sendBroadcastEmail(
        email,
        "Welcome to JustMobile – You're on the list!",
        `G'day,\n\nThanks for joining the JustMobile updates list. You'll be the first to hear about exclusive deals, network updates, and launch offers.\n\nLess telco. More you.\nThe JustMobile Team`,
      )
      .catch((err) => this.logger.warn(`Failed to dispatch welcome email: ${err.message}`));

    return { success: true, message: "You're on the list. We'll be in touch soon with exclusive deals." };
  }

  async getSubscribers(): Promise<{ success: boolean; count: number; subscribers: any[] }> {
    const col = this.getCollection();
    const subscribers = await col.find({}).sort({ createdAt: -1 }).toArray();

    return {
      success: true,
      count: subscribers.length,
      subscribers: subscribers.map((s) => ({
        id: s._id.toString(),
        email: s.email,
        source: s.source,
        status: s.status,
        createdAt: s.createdAt,
      })),
    };
  }

  async deleteSubscriber(email: string): Promise<{ success: boolean; message: string }> {
    const col = this.getCollection();
    await col.deleteOne({ email: email.trim().toLowerCase() });
    return { success: true, message: `Removed ${email} from subscriber list.` };
  }

  async sendBroadcast(dto: BroadcastDto): Promise<{ success: boolean; count: number; message: string }> {
    if (!dto?.subject || !dto.subject.trim()) {
      throw new BadRequestException('Broadcast subject line is required.');
    }
    if (!dto?.message || !dto.message.trim()) {
      throw new BadRequestException('Broadcast message or offer details are required.');
    }
    const col = this.getCollection();
    const activeSubscribers = await col.find({ status: 'active' }).toArray();

    if (activeSubscribers.length === 0) {
      throw new BadRequestException('No active email subscribers found in the registry to broadcast to.');
    }

    this.logger.log(`Starting broadcast dispatch to ${activeSubscribers.length} recipients...`);

    let sentCount = 0;
    const errors: string[] = [];

    for (const sub of activeSubscribers) {
      try {
        const ok = await this.mailService.sendBroadcastEmail(sub.email, dto.subject, dto.message);
        if (ok) sentCount++;
      } catch (err: any) {
        errors.push(`${sub.email}: ${err.message}`);
      }
    }

    // Save broadcast record into audit log
    const broadcastsCol = this.getBroadcastsCollection();
    await broadcastsCol.insertOne({
      subject: dto.subject,
      message: dto.message,
      targetCount: activeSubscribers.length,
      sentCount,
      errorsCount: errors.length,
      sentAt: new Date(),
    });

    this.logger.log(`✓ Broadcast complete: ${sentCount}/${activeSubscribers.length} delivered successfully.`);

    return {
      success: true,
      count: sentCount,
      message: `Broadcast successfully dispatched to ${sentCount} subscriber${sentCount === 1 ? '' : 's'}.`,
    };
  }

  async getBroadcastHistory(): Promise<{ success: boolean; history: any[] }> {
    const broadcastsCol = this.getBroadcastsCollection();
    const history = await broadcastsCol.find({}).sort({ sentAt: -1 }).limit(10).toArray();
    return {
      success: true,
      history: history.map((h) => ({
        id: h._id.toString(),
        subject: h.subject,
        message: h.message,
        sentCount: h.sentCount,
        targetCount: h.targetCount,
        sentAt: h.sentAt,
      })),
    };
  }
}
