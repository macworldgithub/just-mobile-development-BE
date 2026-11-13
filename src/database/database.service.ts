import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { MongoClient, Db, Document } from 'mongodb';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private client: MongoClient;
  private db: Db;

  async onModuleInit() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      this.logger.error('MONGO_URI is not set in environment variables!');
      return;
    }

    try {
      this.logger.log('Connecting to MongoDB...');
      this.client = new MongoClient(uri);
      await this.client.connect();
      this.db = this.client.db('just_mobile_development');
      this.logger.log('Successfully connected to MongoDB database (just_mobile_development).');
      this.ensureIndexes().catch((err) =>
        this.logger.warn(`Failed to ensure MongoDB indexes: ${err.message}`),
      );
    } catch (error) {
      this.logger.error('Failed to connect to MongoDB:', error);
    }
  }

  private async ensureIndexes() {
    if (!this.db) return;
    await Promise.all([
      this.db.collection('users').createIndex({ email: 1 }, { background: true }),
      this.db.collection('users').createIndex({ custNo: 1 }, { background: true }),
      this.db.collection('users').createIndex({ role: 1, createdAt: -1 }, { background: true }),
      this.db.collection('orders').createIndex({ orderId: 1 }, { background: true }),
      this.db.collection('orders').createIndex({ custNo: 1, updatedAt: -1 }, { background: true }),
      this.db.collection('invoices').createIndex({ custNo: 1, issueDate: -1 }, { background: true }),
      this.db.collection('email_verifications').createIndex({ email: 1, code: 1, used: 1 }, { background: true }),
      this.db.collection('newsletter_subscribers').createIndex({ email: 1 }, { background: true }),
    ]);
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.close();
      this.logger.log('MongoDB connection closed.');
    }
  }

  getDb(): Db {
    return this.db;
  }

  getCollection<T extends Document = Document>(name: string) {
    if (!this.db) {
      throw new Error('Database not connected. Please check MONGO_URI.');
    }
    return this.db.collection<T>(name);
  }
}
