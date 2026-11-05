import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WebsitePageRepository, WebsitePagesService, websitePageSchema } from './website-pages.js';

/**
 * What the AI sales agent knows beyond the catalog and settings: pages of the business's own
 * website (ADR 0024). Catalog sync fills it; the agent's search_website tool reads it.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: 'WebsitePage', schema: websitePageSchema }])],
  providers: [WebsitePageRepository, WebsitePagesService],
  exports: [WebsitePagesService],
})
export class KnowledgeModule {}
