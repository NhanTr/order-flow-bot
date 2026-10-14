import express, { type RequestHandler } from "express";

export interface RequestBodyParserOptions {
  jsonLimit?: string;
  urlencodedLimit?: string;
}

export function createRequestBodyParsers(_options: RequestBodyParserOptions = {}): RequestHandler[] {
  const options = _options;
  return [
    express.json({ limit: options.jsonLimit ?? "1mb" }),
    express.urlencoded({
      extended: true,
      limit: options.urlencodedLimit ?? "100kb",
      parameterLimit: 1_000,
    }),
  ];
}
