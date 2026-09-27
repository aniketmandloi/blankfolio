import { createAuth } from "@blankfolio/auth";
import { createDb } from "@blankfolio/db";

import { ENV } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db);
