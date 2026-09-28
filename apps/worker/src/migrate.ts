import { migrateJobQueues } from "@blankfolio/api/research-jobs";

import { ENV } from "./env.server";

if (!ENV.DATABASE_MIGRATION_URL) {
	console.error(
		"Set DATABASE_MIGRATION_URL to a role that can create the pg-boss schema.",
	);
	process.exitCode = 1;
} else {
	await migrateJobQueues(ENV.DATABASE_MIGRATION_URL);
	console.log("job_queue_ready");
}
