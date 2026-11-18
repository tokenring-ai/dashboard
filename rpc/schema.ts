import type { RPCSchema } from "@tokenring-ai/rpc/types";
import { SuccessSchema } from "@tokenring-ai/rpc/types";
import { z } from "zod";

/** Upper bound on one serialized layout; layouts are a few KB. */
export const MAX_LAYOUT_BYTES = 256 * 1024;

export const DashboardIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "dashboard ids are kebab-case");

/** A user-saved app: an arrangement saved under its own name, based on a shipped app. */
export const UserAppSchema = z.object({
  label: z.string().trim().min(1).max(60),
  /** Lucide icon name chosen by the user. */
  icon: z.string().max(40),
  /** The shipped app whose views this arrangement uses. */
  basedOn: DashboardIdSchema,
  group: z.string().max(40).optional(),
});
export type UserApp = z.output<typeof UserAppSchema>;

export const DashboardLayoutRecordSchema = z.object({
  dashboardId: DashboardIdSchema,
  /** Client layout schema version; the client migrates older records. */
  schemaVersion: z.number().int().positive(),
  /** Hash of the client view registry that produced the layout. */
  viewRegistryHash: z.string().max(64),
  /** Opaque serialized layout-engine state (JSON string). Validated client-side, size-limited here. */
  layout: z.string().max(MAX_LAYOUT_BYTES),
  updatedAt: z.number(),
  /** Present when the record is a user-saved app rather than a shipped app's layout. Kept across saves that omit it. */
  app: UserAppSchema.optional(),
});
export type DashboardLayoutRecord = z.output<typeof DashboardLayoutRecordSchema>;

export const DashboardLayoutSummarySchema = DashboardLayoutRecordSchema.omit({ layout: true });
export type DashboardLayoutSummary = z.output<typeof DashboardLayoutSummarySchema>;

const NotFoundSchema = z.object({ status: z.literal("notFound") });

const DashboardRpcSchema = {
  name: "Dashboard RPC",
  path: "/rpc/dashboard",
  methods: {
    getDashboardLayout: {
      type: "query" as const,
      input: z.object({ dashboardId: DashboardIdSchema }),
      result: z.discriminatedUnion("status", [SuccessSchema.extend({ record: DashboardLayoutRecordSchema }), NotFoundSchema]),
    },
    saveDashboardLayout: {
      type: "mutation" as const,
      input: DashboardLayoutRecordSchema.omit({ updatedAt: true }).extend({
        /** Optimistic concurrency: rejected with `conflict` when the stored record is newer than this. */
        expectedUpdatedAt: z.number().optional(),
      }),
      result: z.discriminatedUnion("status", [
        SuccessSchema.extend({ updatedAt: z.number() }),
        z.object({ status: z.literal("conflict"), record: DashboardLayoutRecordSchema }),
      ]),
    },
    deleteDashboardLayout: {
      type: "mutation" as const,
      input: z.object({ dashboardId: DashboardIdSchema }),
      result: z.discriminatedUnion("status", [SuccessSchema, NotFoundSchema]),
    },
    listDashboardLayouts: {
      type: "query" as const,
      input: z.object({}),
      result: z.object({ layouts: z.array(DashboardLayoutSummarySchema) }),
    },
  },
} satisfies RPCSchema;

export default DashboardRpcSchema;
