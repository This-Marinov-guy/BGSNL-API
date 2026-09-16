import { accountActionsService } from "../services/backoffice/account-actions.js";
import express from "express";
import { adminMiddleware, authMiddleware } from "../middleware/authorization.js";
import { accessRequestService } from "../services/backoffice/access-requests.js";
import HttpError from "../models/Http-error.js";
import { accountsBackofficeService } from "../services/backoffice/accounts.js";
import { MEMBER_ADMIN_ACCESS } from "../util/config/defines.js";

export const createBackofficeRouter = ({
  service = accountsBackofficeService,
  requests = accessRequestService,
  actions = accountActionsService,
  authenticate = authMiddleware,
  authorize = adminMiddleware(MEMBER_ADMIN_ACCESS),
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

  router.get("/accounts/:type/:id/membership", async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try { res.json(await actions.inspect({ ...req.params, actor: req.account })); }
    catch (error) { next(error instanceof HttpError ? error : new HttpError("Could not load membership details. Please try again.", 503)); }
  });

  router.post("/accounts/:type/:id/transfer", async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try { res.status(202).json(await actions.requestTransfer({ ...req.params, actor: req.account, body: req.body })); }
    catch (error) { next(error instanceof HttpError ? error : new HttpError("Could not confirm the transfer email. Please check before retrying.", 503)); }
  });

  router.post("/accounts/:type/:id/cancel-subscription", async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try { res.json(await actions.cancel({ ...req.params, actor: req.account, body: req.body })); }
    catch (error) { next(error instanceof HttpError ? error : new HttpError("Could not confirm cancellation. Refresh membership details before retrying.", 503)); }
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
