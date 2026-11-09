import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingModule } from '../billing/billing.module.js';
import { CommerceCoreModule } from '../commerce/commerce.module.js';
import { FilesCoreModule } from '../files/files.module.js';
import { InboxCoreModule } from '../inbox/inbox.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { AiAgentController } from './ai-agent.controller.js';
import { AiRepliesListener } from './ai-replies.listener.js';
import { aiAgentSettingsSchema } from './agent-settings.schema.js';
import { AiAgentSettingsRepository, AiAgentSettingsService } from './agent-settings.service.js';
import { AgentRunner } from './agent/agent-runner.js';
import { AgentTools } from './agent/agent-tools.js';
import { AiRepliesService } from './agent/ai-replies.service.js';
import { AiReplyQueue } from './agent/reply-queue.js';
import { AI_FETCH, AI_PROVIDERS, type AiProvider } from './provider/ai-provider.js';
import { AiProviders } from './provider/ai-providers.service.js';
import { AnthropicProvider } from './provider/anthropic.provider.js';
import { OpenAiTranscriber } from './transcription/openai-transcriber.js';
import { TRANSCRIBERS, type Transcriber } from './transcription/transcriber.js';
import { VoiceNotesService } from './voice-notes/voice-notes.service.js';

/**
 * The AI sales agent without HTTP routes: providers, settings, tools and the reply engine.
 * The worker runs replies with it; the API module adds routes and event listeners.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'AiAgentSettings', schema: aiAgentSettingsSchema }]),
    BillingModule,
    OrgsModule,
    InboxCoreModule,
    CommerceCoreModule,
    FilesCoreModule,
    KnowledgeModule,
  ],
  providers: [
    { provide: AI_FETCH, useFactory: (): typeof fetch => globalThis.fetch.bind(globalThis) },
    AnthropicProvider,
    {
      provide: AI_PROVIDERS,
      inject: [AnthropicProvider],
      useFactory: (anthropic: AnthropicProvider): AiProvider[] => [anthropic],
    },
    AiProviders,
    OpenAiTranscriber,
    {
      provide: TRANSCRIBERS,
      inject: [OpenAiTranscriber],
      useFactory: (openai: OpenAiTranscriber): Transcriber[] => [openai],
    },
    VoiceNotesService,
    AiAgentSettingsRepository,
    AiAgentSettingsService,
    AgentTools,
    AgentRunner,
    AiReplyQueue,
    AiRepliesService,
  ],
  exports: [AiAgentSettingsService, AiRepliesService, AiProviders, VoiceNotesService],
})
export class AiCoreModule {}

/** The AI sales agent's settings routes and the listener that schedules replies. */
@Module({
  imports: [AiCoreModule, BillingModule, InboxCoreModule],
  controllers: [AiAgentController],
  providers: [AiRepliesListener],
})
export class AiModule {}
