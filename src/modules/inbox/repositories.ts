import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type { Channel, Contact, Conversation, Message } from './schemas.js';

@Injectable()
export class ChannelRepository extends TenantScopedRepository<Channel> {
  constructor(@InjectModel('Channel') model: Model<Channel>) {
    super(model);
  }
}

@Injectable()
export class ContactRepository extends TenantScopedRepository<Contact> {
  constructor(@InjectModel('Contact') model: Model<Contact>) {
    super(model);
  }
}

@Injectable()
export class ConversationRepository extends TenantScopedRepository<Conversation> {
  constructor(@InjectModel('Conversation') model: Model<Conversation>) {
    super(model);
  }
}

@Injectable()
export class MessageRepository extends TenantScopedRepository<Message> {
  constructor(@InjectModel('Message') model: Model<Message>) {
    super(model);
  }
}
