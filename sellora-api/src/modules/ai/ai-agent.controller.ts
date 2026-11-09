import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { RequestContext } from '../../common/context/request-context.js';
import { ZodBody } from '../../common/validation/zod.js';
import { RateLimitService } from '../auth/core/rate-limit.service.js';
import { OrgScoped, RequireAnyPermission, RequireModule } from '../auth/decorators.js';
import { MODEL_TIERS } from '../billing/credit-schemas.js';
import { CreditsService } from '../billing/credits.service.js';
import { WalletService, toBalance } from '../billing/wallet.service.js';
import { ChannelsService } from '../inbox/channels.service.js';
import * as dto from './ai-agent.dto.js';
import {
  AiAgentSettingsService,
  toAgentSettingsDto,
  type AiAgentSettingsDoc,
} from './agent-settings.service.js';
import { AiRepliesService } from './agent/ai-replies.service.js';
import { VoiceNotesService } from './voice-notes/voice-notes.service.js';

/** A typical reply: instructions, catalog and recent chat in, a short answer out. */
const TYPICAL_REPLY = { inputTokens: 6_000, outputTokens: 400 };

@ApiTags('ai agent')
@OrgScoped()
@RequireModule('ai_agent')
@RequireAnyPermission('ai.settings.manage', 'ai.knowledge.manage')
@Controller({ path: 'orgs/:orgId/ai-agent', version: '1' })
export class AiAgentController {
  constructor(
    private readonly settings: AiAgentSettingsService,
    private readonly replies: AiRepliesService,
    private readonly credits: CreditsService,
    private readonly wallet: WalletService,
    private readonly channels: ChannelsService,
    private readonly rateLimit: RateLimitService,
    private readonly voiceNotes: VoiceNotesService,
  ) {}

  /** Each tier's cost for a typical reply, and whether it can answer now. */
  private async tiers() {
    return Promise.all(
      MODEL_TIERS.map(async (tier) => {
        const [ready, quote] = await Promise.all([
          this.replies.serviceReady({ tier }),
          this.credits.quote(tier, TYPICAL_REPLY).catch(() => null),
        ]);
        return {
          tier,
          available: ready,
          perReply: quote
            ? { credits: quote.credits, amountMinor: quote.amountMinor, currency: quote.currency }
            : null,
        };
      }),
    );
  }

  private async view(settings: AiAgentSettingsDoc) {
    const [tiers, wallet, channels, voiceNotes] = await Promise.all([
      this.tiers(),
      this.wallet.get(),
      this.channels.list(),
      this.voiceNotes.status(),
    ]);
    const current = tiers.find((t) => t.tier === settings.tier)!;
    return {
      settings: toAgentSettingsDto(settings),
      status: {
        serviceReady: current.available,
        perReply: current.perReply,
        tiers,
        voiceNotes,
        wallet: { availableMinor: toBalance(wallet).availableMinor, currency: wallet.currency },
        channels: channels.map((c) => ({
          id: c._id.toHexString(),
          name: c.name,
          type: c.type,
          status: c.status,
          aiEnabled: c.aiEnabled,
          // A turned-off channel, or one Meta stopped accepting, cannot carry replies.
          aiCanReply: c.status === 'active',
        })),
      },
    };
  }

  @Get()
  @ApiOperation({ summary: 'AI sales agent settings, readiness and cost per reply' })
  async get() {
    return this.view(await this.settings.get());
  }

  @Patch()
  @ApiOperation({
    summary: 'Change the agent. Behaviour needs ai.settings.manage, knowledge ai.knowledge.manage.',
  })
  async update(@ZodBody(dto.agentSettingsPatch) body: z.infer<typeof dto.agentSettingsPatch>) {
    return this.view(await this.settings.update(body));
  }

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Test chat with the agent. Nothing is saved or sent; it spends AI credits.',
  })
  async preview(@ZodBody(dto.previewBody) body: z.infer<typeof dto.previewBody>) {
    const userId = RequestContext.actor().id;
    await this.rateLimit.consume('ai:preview', userId);
    return this.replies.preview(body, userId);
  }
}
