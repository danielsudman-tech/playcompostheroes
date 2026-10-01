import { Router, type IRouter } from "express";
import gameRouter from "./game";
import adminRouter from "./admin";
import authRouter from "./auth";
import eventsRouter from "./events";

const router: IRouter = Router();

router.use(authRouter);
router.use(gameRouter);
router.use(eventsRouter);
router.use(adminRouter);

export default router;
