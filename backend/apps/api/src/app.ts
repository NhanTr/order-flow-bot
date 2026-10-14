import "./config/load-env";

import express, { type Application } from "express";
import helmet from "helmet";
import { createClient } from "redis";
import { createSepayRouter } from "./modules/sepay/sepay.routes";

import { createDatabasePool } from "./config/database.js";
import { getEnv } from "./config/env.js";
import { errorHandler, notFound, requestId } from "./middleware/index.js";
import { createSecurityLimiters, type SecurityLimiters } from "./middleware/rate-limit.js";
import { AuthRepository } from "./modules/auth/auth.repository.js";
import { RedisAuthSessionStore } from "./modules/auth/redis-auth-session.store.js";
import { AuthService, type AuthServicePort } from "./modules/auth/auth.service.js";
import { AuthTokenService } from "./modules/auth/auth.tokens.js";
import {
  createTelegramSessionRouter,
  type TelegramSessionRouterOptions,
} from "./modules/auth/telegram-session.routes.js";
import {
  createTelegramBaristaRouter,
  type TelegramBaristaRouterOptions,
} from "./modules/barista/telegram-barista.routes.js";
import { EmployeeRepository } from "./modules/employees/employee.repository.js";
import {
  EmployeeService,
  type EmployeeServicePort,
} from "./modules/employees/employee.service.js";
import { CategoryRepository } from "./modules/menu/category.repository.js";
import {
  CategoryService,
  type CategoryServicePort,
} from "./modules/menu/category.service.js";
import { ItemRepository } from "./modules/menu/item.repository.js";
import { ItemService, type ItemServicePort } from "./modules/menu/item.service.js";
import {
  createTelegramOrderRouter,
  type TelegramOrderRouterOptions,
} from "./modules/orders/telegram-order.routes.js";
import { createApiRouter } from "./routes/index.js";

export interface CreateAppOptions {
  authService?: AuthServicePort;
  mountOperationalRoutes?: boolean;
  employeeService?: EmployeeServicePort;
  categoryService?: CategoryServicePort;
  itemService?: ItemServicePort;
  telegramBotSession?: TelegramSessionRouterOptions;
  /** @deprecated Use telegramBotSession. */
  telegramSession?: TelegramSessionRouterOptions;
  telegramOrders?: Omit<TelegramOrderRouterOptions, "internalSecret">;
  telegramBarista?: Omit<TelegramBaristaRouterOptions, "internalSecret">;
}

export function createApp(options: CreateAppOptions = {}): Application {
  const app = express();
  let authService = options.authService;
  let employeeService = options.employeeService;
  let categoryService = options.categoryService;
  let itemService = options.itemService;
  let telegramBotSession = options.telegramBotSession ?? options.telegramSession;
  let securityLimiters: SecurityLimiters | undefined;
  let dispose = async () => undefined;
  const botOnly =
    !authService &&
    Boolean(telegramBotSession || options.telegramOrders || options.telegramBarista);

  if (!authService && !botOnly) {
    const env = getEnv();
    const pool = createDatabasePool(env);
    const redisClient = createClient({
      url: env.REDIS_URL,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 2_000),
      },
    });
    redisClient.on("error", () => undefined);
    void redisClient.connect().catch(() => undefined);
    const sessions = new RedisAuthSessionStore(redisClient);
    securityLimiters = createSecurityLimiters(redisClient, {
      proxySecret: env.API_PROXY_SECRET,
      trustProxyHops: env.TRUST_PROXY_HOPS,
    });
    app.set("trust proxy", env.TRUST_PROXY_HOPS);
    authService = new AuthService(
      new AuthRepository(pool),
      sessions,
      new AuthTokenService(env),
      env,
    );
    employeeService = new EmployeeService(new EmployeeRepository(pool));
    categoryService = new CategoryService(new CategoryRepository(pool));
    itemService = new ItemService(new ItemRepository(pool));
    if (!telegramBotSession && env.BOT_INTERNAL_SECRET) {
      telegramBotSession = { internalSecret: env.BOT_INTERNAL_SECRET };
    }
    dispose = async () => {
      if (redisClient.isOpen) redisClient.destroy();
      await pool.end();
    };
  }

  app.locals.dispose = dispose;
  app.use(requestId);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  if (securityLimiters) {
    app.use(securityLimiters.clientIdentity);
    app.use("/api/v1/admin/auth/login", securityLimiters.loginIp, securityLimiters.loginAccount);
    app.use("/api/v1/admin/auth/refresh", securityLimiters.refreshIp);
    app.use("/api/v1/telegram/session", securityLimiters.telegramIp);
  }

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "order-flow-api" });
  });

  const apiV1 = express.Router();
  const botInternalSecret =
    telegramBotSession?.internalSecret ?? process.env.BOT_INTERNAL_SECRET ?? "";

  if (botInternalSecret) {
    apiV1.use(
      "/telegram/bot",
      createTelegramSessionRouter(
        telegramBotSession ?? { internalSecret: botInternalSecret },
      ),
    );

    const telegramOperationalRouter = express.Router();
    telegramOperationalRouter.use(
      createTelegramOrderRouter({
        internalSecret: botInternalSecret,
        ...options.telegramOrders,
      }),
    );
    telegramOperationalRouter.use(
      createTelegramBaristaRouter({
        internalSecret: botInternalSecret,
        ...options.telegramBarista,
      }),
    );
    apiV1.use((request, response, next) => {
      if (!request.header("x-bot-internal-secret")) {
        next();
        return;
      }
      telegramOperationalRouter(request, response, next);
    });
  }

  apiV1.use("/webhooks/sepay", createSepayRouter());

  if (authService) {
    apiV1.use(createApiRouter(
      authService,
      options.mountOperationalRoutes ?? options.authService === undefined,
      employeeService,
      categoryService,
      itemService,
      {},
      securityLimiters,
    ));
  }
  app.use("/api/v1", apiV1);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
