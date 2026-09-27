import { createApp } from "./app";
import { ENV } from "./env.server";
import { auth, db } from "./services";
export default createApp({ auth, db, corsOrigin: ENV.CORS_ORIGIN });
