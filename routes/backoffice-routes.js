import express from "express";
import { adminMiddleware, authMiddleware } from "../middleware/authorization.js";
import { accessRequestService } from "../services/backoffice/access-requests.js";
import HttpError from "../models/Http-error.js";
import { accountsBackofficeService } from "../services/backoffice/accounts.js";
import { ACCESS_3 } from "../util/config/defines.js";

export const createBackofficeRouter = ({
  service = accountsBackofficeService,
  requests = accessRequestService,
  authenticate = authMiddleware,
  authorize = adminMiddleware(ACCESS_3),
} = {}) => {
  const router = express.Router();
  router.post("/access-requests", authenticate, async (req, res, next) => {
    try {
      res.status(202).json(await requests.request({ account: req.account, body: req.body }));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError("Could not submit your access request. Please try again.", 503));
    }
  });
  router.use(authorize);

  router.get("/accounts", async (req, res, next) => {
    try {
      res.status(200).json(await service.list(req.query, req.account));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError("Could not load accounts", 500));
    }
  });

  router.patch("/accounts/:type/:id", async (req, res, next) => {
    try {
      res.status(200).json(await service.update({
        type: req.params.type,
        id: req.params.id,
        body: req.body,
        actor: req.account,
      }));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError("Could not update account", 500));
    }
  });

  return router;
};

export default createBackofficeRouter();
