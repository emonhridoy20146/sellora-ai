import {
  Types,
  type QueryFilter,
  type Model,
  type PipelineStage,
  type ProjectionType,
  type QueryOptions,
  type UpdateQuery,
} from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import {
  buildPage,
  decodeCursor,
  keysetFilter,
  type Page,
} from '../../common/pagination/cursor.js';
import type { WithId } from './schema-helpers.js';

export class MissingTenantScopeError extends Error {
  constructor(repo: string) {
    super(`${repo} was used outside a tenant scope`);
    this.name = 'MissingTenantScopeError';
  }
}

type Doc<T> = WithId<T> & { orgId: Types.ObjectId };

/**
 * Base class for repositories of tenant-owned data. Every method pins the query to the
 * tenant in the RequestContext, so callers cannot forget the orgId filter, and a
 * repository used outside a tenant scope fails loudly.
 */
export abstract class TenantScopedRepository<T extends object> {
  protected constructor(protected readonly model: Model<T>) {}

  protected orgId(): Types.ObjectId {
    const tenant = RequestContext.tenant();
    if (!tenant) throw new MissingTenantScopeError(this.constructor.name);
    return new Types.ObjectId(tenant.orgId);
  }

  protected scope(filter: QueryFilter<T> = {}): QueryFilter<T> {
    return { ...filter, orgId: this.orgId() };
  }

  async findById(
    id: string | Types.ObjectId,
    projection?: ProjectionType<T>,
  ): Promise<Doc<T> | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.model
      .findOne(this.scope({ _id: new Types.ObjectId(id) }), projection)
      .lean<Doc<T>>()
      .exec();
  }

  async findOne(
    filter: QueryFilter<T>,
    projection?: ProjectionType<T>,
    options?: QueryOptions<T>,
  ): Promise<Doc<T> | null> {
    return this.model.findOne(this.scope(filter), projection, options).lean<Doc<T>>().exec();
  }

  async find(
    filter: QueryFilter<T> = {},
    options: QueryOptions<T> & { projection?: ProjectionType<T> } = {},
  ): Promise<Doc<T>[]> {
    const { projection, ...rest } = options;
    return this.model.find(this.scope(filter), projection, rest).lean<Doc<T>[]>().exec();
  }

  async count(filter: QueryFilter<T> = {}): Promise<number> {
    return this.model.countDocuments(this.scope(filter)).exec();
  }

  async exists(filter: QueryFilter<T>): Promise<boolean> {
    return (await this.model.exists(this.scope(filter))) !== null;
  }

  async create(data: Omit<Partial<T>, 'orgId'> & { _id?: Types.ObjectId }): Promise<Doc<T>> {
    const created = (await this.model.create([
      { ...data, orgId: this.orgId() },
    ] as never)) as unknown as { toObject(): unknown }[];
    return created[0]!.toObject() as Doc<T>;
  }

  async insertMany(data: Omit<Partial<T>, 'orgId'>[]): Promise<number> {
    if (data.length === 0) return 0;
    const orgId = this.orgId();
    const res = await this.model.insertMany(
      data.map((d) => ({ ...d, orgId })),
      { ordered: true },
    );
    return res.length;
  }

  async updateOne(
    filter: QueryFilter<T>,
    update: UpdateQuery<T>,
  ): Promise<{ matched: number; modified: number }> {
    const res = await this.model
      .updateOne(this.scope(filter), update, { runValidators: true })
      .exec();
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }

  async updateMany(filter: QueryFilter<T>, update: UpdateQuery<T>): Promise<number> {
    const res = await this.model
      .updateMany(this.scope(filter), update, { runValidators: true })
      .exec();
    return res.modifiedCount;
  }

  async findOneAndUpdate(
    filter: QueryFilter<T>,
    update: UpdateQuery<T>,
    options: QueryOptions<T> = {},
  ): Promise<Doc<T> | null> {
    return this.model
      .findOneAndUpdate(this.scope(filter), update, {
        returnDocument: 'after',
        runValidators: true,
        ...options,
      })
      .lean<Doc<T>>()
      .exec();
  }

  async deleteOne(filter: QueryFilter<T>): Promise<boolean> {
    const res = await this.model.deleteOne(this.scope(filter)).exec();
    return res.deletedCount === 1;
  }

  async deleteMany(filter: QueryFilter<T>): Promise<number> {
    const res = await this.model.deleteMany(this.scope(filter)).exec();
    return res.deletedCount;
  }

  async aggregate<R>(pipeline: PipelineStage[]): Promise<R[]> {
    const first = pipeline[0];
    const match =
      first && '$match' in first
        ? { ...first.$match, orgId: this.orgId() }
        : { orgId: this.orgId() };
    const rest = first && '$match' in first ? pipeline.slice(1) : pipeline;
    return this.model.aggregate<R>([{ $match: match }, ...rest]).exec();
  }

  /** Keyset pagination, newest first by `sortField` then _id. */
  async paginate(
    filter: QueryFilter<T>,
    query: { limit: number; cursor?: string },
    sortField = '_id',
    projection?: ProjectionType<T>,
  ): Promise<Page<Doc<T>>> {
    const cursor = decodeCursor(query.cursor);
    const keyset = keysetFilter(sortField, cursor);
    const combined = Object.keys(keyset).length ? { $and: [filter, keyset] } : filter;
    const sort: Record<string, 1 | -1> =
      sortField === '_id' ? { _id: -1 } : { [sortField]: -1, _id: -1 };
    const docs = await this.model
      .find(this.scope(combined as QueryFilter<T>), projection)
      .sort(sort)
      .limit(query.limit + 1)
      .lean<Doc<T>[]>()
      .exec();
    return buildPage(docs, query.limit, sortField);
  }
}
