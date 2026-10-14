import { NextFunction, Request, Response } from "express";
import { requireOwnerActor } from "../auth/auth.middleware";
import { RefundService } from "./refund.service";
import { validateRefundOrder } from "./refund.validation";

type RefundParams = { orderId: string };

export class RefundController {
  constructor(private readonly refundService: RefundService) {}

  public refundOrder = async (
    req: Request<RefundParams>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const actor = requireOwnerActor(req);
      const v = validateRefundOrder(req.body);
      if (!v.isValid) {
        res.status(400).json({ message: "Validation failed", errors: v.errors });
        return;
      }

      res.status(200).json(
        await this.refundService.refundOrder(req.params.orderId, {
          ...req.body,
          refundedByUserId: actor.userId,
        })
      );
    } catch (err) {
      next(err);
    }
  };
}
