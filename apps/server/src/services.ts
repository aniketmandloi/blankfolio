import {
	parseSourcePrices,
	parseSourceQuotas,
} from "@blankfolio/api/literature-sources";
import { createDatabaseJobQueue } from "@blankfolio/api/research-jobs";
import { createAuth } from "@blankfolio/auth";
import { createDb } from "@blankfolio/db";

import { ENV } from "./env.server";
import { createMailDelivery } from "./mail";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db, createMailDelivery(ENV));
export const jobQueue = createDatabaseJobQueue(db);
export const sourceSettings = {
	prices: parseSourcePrices(ENV.LITERATURE_SOURCE_PRICES),
	quotas: parseSourceQuotas(ENV.LITERATURE_SOURCE_QUOTAS),
	fixtureSources: ENV.LITERATURE_FIXTURE_SOURCES === true,
};
