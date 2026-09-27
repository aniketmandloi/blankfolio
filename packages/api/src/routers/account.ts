import { protectedProcedure, router } from "../index";
import { pilotAccessStatus } from "../pilot-access";

export const accountRouter = router({
	access: protectedProcedure.query(async ({ ctx }) => ({
		status: await pilotAccessStatus(ctx.db, ctx.session.user.id),
	})),
});
