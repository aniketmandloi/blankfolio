import { createAuth } from "@blankfolio/auth";
import { createDb } from "@blankfolio/db";

import { ENV } from "./env.server";
import { createMailDelivery } from "./mail";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db, createMailDelivery(ENV));
