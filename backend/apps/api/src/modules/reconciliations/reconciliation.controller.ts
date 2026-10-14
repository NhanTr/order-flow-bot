import { NextFunction, Request, Response } from "express";
import { requireOwnerActor } from "../auth/auth.middleware";
import { ReconciliationService } from "./reconciliation.service";
import { validateResolveReconciliation } from "./reconciliation.validation";
import { parsePagination } from "../../middleware/pagination";

type TransactionParams = { transactionId: string };
type ReconciliationParams = { reconciliationId: string };

export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  public listTransactions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await this.service.listTransactions(parsePagination(req.query)));
    } catch (err) {
      next(err);
    }
  };

  public getTransaction = async (
    req: Request<TransactionParams>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      res.status(200).json(await this.service.getTransaction(req.params.transactionId));
    } catch (err) {
      next(err);
    }
  };

  public listReconciliations = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await this.service.listReconciliations(parsePagination(req.query)));
    } catch (err) {
      next(err);
    }
  };

  public getReconciliation = async (
    req: Request<ReconciliationParams>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      res.status(200).json(await this.service.getReconciliation(req.params.reconciliationId));
    } catch (err) {
      next(err);
    }
  };

  public resolveReconciliation = async (
    req: Request<ReconciliationParams>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const actor = requireOwnerActor(req);
      const input = {
        ...req.body,
        resolvedByUserId: actor.userId,
      };
      const v = validateResolveReconciliation(input);
      if (!v.isValid) {
        res.status(400).json({ message: "Validation failed", errors: v.errors });
        return;
      }

      res.status(200).json(
        await this.service.resolveReconciliation(req.params.reconciliationId, input)
      );
    } catch (err) {
      next(err);
    }
  };
}
