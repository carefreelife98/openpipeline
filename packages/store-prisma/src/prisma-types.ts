// Minimal structural interface for the Prisma client this store needs. Declaring
// it ourselves (instead of importing the generated client) lets the package
// build and typecheck WITHOUT running `prisma generate` first, and keeps generated
// code out of source control. Any PrismaClient generated from this package's
// schema.prisma satisfies it structurally.

export interface PrismaDelegateFindArgs {
  where?: unknown;
  orderBy?: unknown;
  select?: unknown;
  include?: unknown;
  take?: number;
  data?: unknown;
}

export interface PrismaModelDelegate {
  create(args: { data: unknown }): Promise<{ id: string; [k: string]: unknown }>;
  createMany(args: { data: unknown[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
  findUnique(args: { where: unknown; include?: unknown }): Promise<Record<string, unknown> | null>;
  findFirst(args: PrismaDelegateFindArgs): Promise<Record<string, unknown> | null>;
  findMany(args?: PrismaDelegateFindArgs): Promise<Record<string, unknown>[]>;
  update(args: { where: unknown; data: unknown }): Promise<{ id: string; [k: string]: unknown }>;
  updateMany(args: { where: unknown; data: unknown }): Promise<{ count: number }>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
}

export interface PrismaClientLike {
  workflow: PrismaModelDelegate;
  workflowNode: PrismaModelDelegate;
  workflowEdge: PrismaModelDelegate;
  workflowRun: PrismaModelDelegate;
  workflowRunStep: PrismaModelDelegate;
  $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
