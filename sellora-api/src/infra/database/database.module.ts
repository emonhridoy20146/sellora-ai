import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import mongoose from 'mongoose';
import { AppConfig } from '../../config/app-config.js';
import { CounterService } from './counter.service.js';
import { TransactionService } from './transaction.service.js';

mongoose.set('transactionAsyncLocalStorage', true);
mongoose.set('strictQuery', true);

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        uri: config.get('MONGODB_URI'),
        dbName: config.get('MONGODB_DB_NAME'),
        autoIndex: config.get('MONGODB_AUTO_INDEX'),
        autoCreate: true,
        maxPoolSize: 50,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 10_000,
        retryWrites: true,
        writeConcern: { w: 'majority' },
      }),
    }),
  ],
  providers: [TransactionService, CounterService],
  exports: [TransactionService, CounterService],
})
export class DatabaseModule {}
