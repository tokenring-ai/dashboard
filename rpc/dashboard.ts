import type TokenRingApp from "@tokenring-ai/app";
import { createRPCEndpoint } from "@tokenring-ai/rpc/createRPCEndpoint";
import type { RpcCallContext } from "@tokenring-ai/rpc/types";
import DashboardLayoutService from "../DashboardLayoutService.ts";
import DashboardRpcSchema from "./schema.ts";

function service(app: TokenRingApp) {
  return app.requireService(DashboardLayoutService);
}

function scope(app: TokenRingApp, context: RpcCallContext | undefined) {
  return service(app).scopeFor(context?.username);
}

export default createRPCEndpoint(DashboardRpcSchema, {
  async getDashboardLayout(args, app, context) {
    const record = await service(app).get(await scope(app, context), args.dashboardId);
    return record ? { status: "success" as const, record } : { status: "notFound" as const };
  },

  async saveDashboardLayout(args, app, context) {
    return service(app).save(await scope(app, context), args);
  },

  async deleteDashboardLayout(args, app, context) {
    const deleted = await service(app).delete(await scope(app, context), args.dashboardId);
    return deleted ? { status: "success" as const } : { status: "notFound" as const };
  },

  async listDashboardLayouts(_args, app, context) {
    return { layouts: await service(app).list(await scope(app, context)) };
  },
});
