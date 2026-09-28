import { varlockNextConfigPlugin } from "@varlock/nextjs-integration/plugin";
import type { NextConfig } from "next";

const withVarlock = varlockNextConfigPlugin();

const nextConfig: NextConfig = {
	typedRoutes: true,
	reactCompiler: true,
};

export default withVarlock(nextConfig);
