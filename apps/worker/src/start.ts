import {
	parseSourcePrices,
	parseSourceQuotas,
} from "@blankfolio/api/literature-sources";
import { runLiteratureWorker } from "@blankfolio/api/literature-worker";
import { createDb } from "@blankfolio/db";

import { ENV } from "./env.server";

const db = createDb(ENV, { persistent: true });
const stop = await runLiteratureWorker(ENV.DATABASE_URL, {
	db,
	prices: parseSourcePrices(ENV.LITERATURE_SOURCE_PRICES),
	quotas: parseSourceQuotas(ENV.LITERATURE_SOURCE_QUOTAS),
});
console.log("literature_worker_started");
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		void stop()
			.then(() => db.$client.end())
			.then(() => process.exit(0));
	});
