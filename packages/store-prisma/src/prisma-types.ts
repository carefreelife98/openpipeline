// Minimal structural interface for the Prisma client this store needs. Declaring
// it ourselves (instead of importing the generated client) lets the package
// build and typecheck WITHOUT running `prisma generate` first, and keeps generated
// code out of source control. Any PrismaClient generated from this package's
// schema.prisma satisfies it structurally.
//
// The delegate methods are generic over the row shape they return and the data
// shape they accept. Each call site supplies the precise `select`/`include`
// projection it reads, so results are fully typed and no `as`-cast is needed to
// access columns. JSON-valued columns are modelled as `JsonInput` (any JSON-
// serializable value); the host's real Prisma client validates them at runtime.

/** Any value that can be persisted to a Prisma `Json` column. */
export type JsonInput = unknown;

export interface PrismaDelegateFindArgs {
  where?: unknown;
  orderBy?: unknown;
  select?: unknown;
  include?: unknown;
  take?: number;
}

export interface PrismaModelDelegate {
  create<TRow extends { id: string }>(args: { data: object }): Promise<TRow>;
  createMany(args: { data: object[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
  findUnique<TRow>(args: {
    where: unknown;
    include?: unknown;
    select?: unknown;
  }): Promise<TRow | null>;
  findFirst<TRow>(args: PrismaDelegateFindArgs): Promise<TRow | null>;
  findMany<TRow>(args?: PrismaDelegateFindArgs): Promise<TRow[]>;
  update<TRow extends { id: string }>(args: { where: unknown; data: object }): Promise<TRow>;
  updateMany(args: { where: unknown; data: object }): Promise<{ count: number }>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
}

export interface PrismaClientLike {
  pipeline: PrismaModelDelegate;
  pipelineNode: PrismaModelDelegate;
  pipelineEdge: PrismaModelDelegate;
  pipelineRun: PrismaModelDelegate;
  pipelineRunStep: PrismaModelDelegate;
  $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
