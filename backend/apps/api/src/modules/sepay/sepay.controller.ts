import { NextFunction, Request, Response } from "express";
import { SepayService } from "./sepay.service";

export class SepayController {
  constructor(private readonly sepayService: SepayService) {}

  public handleWebhook = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const result = await this.sepayService.handleWebhook(req.body, req.headers);
      res.status(200).json({ success: true, ok: true, ...result });
    } catch (err) {
      next(err);
    }
  };
}

