import type { TokenRingPlugin } from "@tokenring-ai/app";
import { RpcService } from "@tokenring-ai/rpc";
import DashboardLayoutService from "./DashboardLayoutService.ts";
import packageJSON from "./package.json" with { type: "json" };
import dashboardRPC from "./rpc/dashboard.ts";

export default {
  name: packageJSON.name,
  displayName: "Dashboard Layouts",
  version: packageJSON.version,
  description: packageJSON.description,
  install(app) {
    app.addService(DashboardLayoutService, new DashboardLayoutService(app));
    app.waitForService(RpcService, rpcService => {
      rpcService.registerEndpoint(dashboardRPC);
    });
  },
} satisfies TokenRingPlugin;
