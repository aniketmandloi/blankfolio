import { createApp } from "./app";
import { ENV } from "./env.server";
import { auth, db, jobQueue, sourcePrices } from "./services";
export default createApp({
	auth,
	db,
	corsOrigin: ENV.CORS_ORIGIN,
	jobQueue,
	sourcePrices,
});
