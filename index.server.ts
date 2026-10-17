import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDroidProvider } from "./server/provider";
import { createDroidUsageSource } from "./server/usage";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDroidProvider());
  server.registerUsageSource(createDroidUsageSource());
  return () => {};
}
