import { parseArgs } from "node:util";
import {
	changePilotAccess,
	pilotAccessHistory,
} from "@blankfolio/api/pilot-access";
import { createDb } from "@blankfolio/db";
import { z } from "zod";

import { ENV } from "./env.server";

const usage = `Usage:
  pnpm --filter server pilot:access invite <email> --actor <operator> --reason <text>
  pnpm --filter server pilot:access revoke <email> --actor <operator> --reason <text>
  pnpm --filter server pilot:access history <email>`;
const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { actor: { type: "string" }, reason: { type: "string" } },
});
const [command, email] = positionals;
const db = createDb(ENV);
try {
	if (!email || !["invite", "revoke", "history"].includes(command ?? ""))
		throw new Error(usage);
	if (command === "invite" || command === "revoke")
		await changePilotAccess(db, {
			action: command,
			email,
			actor: values.actor ?? "",
			reason: values.reason ?? "",
		});
	console.table(await pilotAccessHistory(db, email));
} catch (error) {
	console.error(
		error instanceof z.ZodError
			? z.prettifyError(error)
			: error instanceof Error
				? error.message
				: error,
	);
	process.exitCode = 1;
} finally {
	await db.$client.end();
}
