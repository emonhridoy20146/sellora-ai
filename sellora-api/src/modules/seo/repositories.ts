import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { TenantScopedRepository } from '../../infra/database/tenant-scoped.repository.js';
import type {
  ContentDraft,
  KeywordList,
  KeywordResearch,
  SearchConsoleDay,
  SearchConsoleRow,
  SeoBulkRun,
  SeoGoogle,
} from './schemas.js';

@Injectable()
export class KeywordResearchRepository extends TenantScopedRepository<KeywordResearch> {
  constructor(@InjectModel('KeywordResearch') model: Model<KeywordResearch>) {
    super(model);
  }
}

@Injectable()
export class KeywordListRepository extends TenantScopedRepository<KeywordList> {
  constructor(@InjectModel('KeywordList') model: Model<KeywordList>) {
    super(model);
  }
}

@Injectable()
export class SeoGoogleRepository extends TenantScopedRepository<SeoGoogle> {
  constructor(@InjectModel('SeoGoogle') model: Model<SeoGoogle>) {
    super(model);
  }
}

@Injectable()
export class SearchConsoleDayRepository extends TenantScopedRepository<SearchConsoleDay> {
  constructor(@InjectModel('SearchConsoleDay') model: Model<SearchConsoleDay>) {
    super(model);
  }
}

@Injectable()
export class SearchConsoleRowRepository extends TenantScopedRepository<SearchConsoleRow> {
  constructor(@InjectModel('SearchConsoleRow') model: Model<SearchConsoleRow>) {
    super(model);
  }
}

@Injectable()
export class SeoBulkRunRepository extends TenantScopedRepository<SeoBulkRun> {
  constructor(@InjectModel('SeoBulkRun') model: Model<SeoBulkRun>) {
    super(model);
  }
}

@Injectable()
export class ContentDraftRepository extends TenantScopedRepository<ContentDraft> {
  constructor(@InjectModel('ContentDraft') model: Model<ContentDraft>) {
    super(model);
  }
}
