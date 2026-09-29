import { accountActionsService } from "../services/backoffice/account-actions.js";
import express from "express";
import multer from "multer";
import { adminMiddleware, authMiddleware } from "../middleware/authorization.js";
import { accessRequestService } from "../services/backoffice/access-requests.js";
import HttpError from "../models/Http-error.js";
import { accountsBackofficeService } from "../services/backoffice/accounts.js";
import { MEMBER_ADMIN_ACCESS } from "../util/config/defines.js";
import { MAX_IMPORT_BYTES, roleImportTemplate } from "../services/backoffice/account-role-import.js";

const roleSheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }).single("file");

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

  router.get("/accounts/bulk-roles/template", (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.set("Content-Disposition", 'attachment; filename="account-role-import.xlsx"');
      res.send(roleImportTemplate());
    } catch (error) { next(error); }
  });

  router.post("/accounts/bulk-roles/preview", (req, res, next) => {
    roleSheetUpload(req, res, async (uploadError) => {
      if (uploadError) return next(new HttpError("Choose an .xlsx file smaller than 1 MB", 422));
      try {
        res.set("Cache-Control", "private, no-store");
        res.json(await service.previewRoleImport({ file: req.file, actor: req.account }));
      } catch (error) { next(error instanceof HttpError ? error : new HttpError("Could not review the import", 500)); }
    });
  });

  router.post("/accounts/bulk-roles/apply", async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      res.json(await service.applyRoleImport({ rows: req.body?.rows, actor: req.account }));
    } catch (error) { next(error instanceof HttpError ? error : new HttpError("Could not apply role changes", 500)); }
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
