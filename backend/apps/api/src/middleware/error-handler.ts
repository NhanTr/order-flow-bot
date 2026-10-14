import type { ErrorRequestHandler } from "express";
import { isHttpError } from "http-errors";
import { ZodError } from "zod";

import { AppError } from "../core/errors.js";

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        requestId: request.requestId,
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        requestId: request.requestId,
      },
    });
    return;
  }

  if (isHttpError(error)) {
    const parserType = (error as { type?: string }).type;
    const isMalformedBody = error.statusCode === 400 && parserType === "entity.parse.failed";
    const isOversizedBody = error.statusCode === 413 || parserType === "entity.too.large";
    const isServerError = error.statusCode >= 500;
    response.status(error.statusCode).json({
      error: {
        code: isOversizedBody
          ? "PAYLOAD_TOO_LARGE"
          : error.statusCode === 400
            ? "VALIDATION_ERROR"
            : error.statusCode === 401
              ? "UNAUTHORIZED"
              : "HTTP_ERROR",
        message: isOversizedBody
          ? "Request body is too large"
          : isMalformedBody
            ? "Malformed request body"
            : isServerError
              ? "Internal server error"
              : error.message,
        requestId: request.requestId,
      },
    });
    return;
  }

  console.error({ error, requestId: request.requestId });
  response.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
      requestId: request.requestId,
    },
  });
};

