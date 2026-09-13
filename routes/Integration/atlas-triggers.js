import express from "express";
import { requireServiceKey } from "../../middleware/pass-secure.js";
import { createAtlasEventTriggerHandler } from "../../controllers/Integration/atlas-event-trigger-controller.js";

export const createAtlasTriggerRouter = (dependencies) => {
  const router = express.Router();
  router.post("/member-event-announcement", requireServiceKey("ATLAS_EVENT_TRIGGER_SECRET"), createAtlasEventTriggerHandler(dependencies));
  return router;
};

export default createAtlasTriggerRouter();
