import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { ASSETS_DIR } from "./routes/admin.js";

const app: Express = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Serve the assets directory at /api/assets so uploaded images are always
// reachable in both dev and production (production static build only includes
// files present at build time; runtime uploads need a live file server)
app.use("/api/assets", express.static(ASSETS_DIR));

app.use("/api", router);

export default app;
