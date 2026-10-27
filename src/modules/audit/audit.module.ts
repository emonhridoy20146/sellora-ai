import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { auditEventSchema, auditHeadSchema } from './audit-event.schema.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'AuditEvent', schema: auditEventSchema },
      { name: 'AuditHead', schema: auditHeadSchema },
    ]),
  ],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
