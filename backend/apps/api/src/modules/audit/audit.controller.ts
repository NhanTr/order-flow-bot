import { NextFunction, Request, Response } from "express";
import { AuditService } from "./audit.service";
import { parsePagination } from "../../middleware/pagination";

export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  public listAuditLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await this.auditService.listAuditLogs(parsePagination(req.query)));
    } catch (err) {
      next(err);
    }
  };
}

