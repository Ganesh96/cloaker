var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }
    if (url.pathname === "/health") {
      return json({ ok: true, service: "snipe-and-cloak-mei-worker" });
    }
    if (url.pathname === "/api/mei/start" && request.method === "POST") {
      const body = await request.json();
      const sessionId = crypto.randomUUID();
      const id = env.MEI_SESSION.idFromName(sessionId);
      const stub = env.MEI_SESSION.get(id);
      const response = await stub.fetch("https://mei-session/start", {
        method: "POST",
        body: JSON.stringify({ ...body, session_id: sessionId })
      });
      return corsResponse(await response.text(), response.status, {
        "content-type": "application/json"
      });
    }
    const meiMatch = url.pathname.match(/^\/api\/mei\/([^/]+)$/);
    if (meiMatch && request.method === "GET") {
      const sessionId = meiMatch[1];
      const id = env.MEI_SESSION.idFromName(sessionId);
      const stub = env.MEI_SESSION.get(id);
      const response = await stub.fetch("https://mei-session/status");
      return corsResponse(await response.text(), response.status, {
        "content-type": "application/json"
      });
    }
    return json({ error: "not_found" }, 404);
  }
};
var MeiSession = class {
  static {
    __name(this, "MeiSession");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/start" && request.method === "POST") {
      const body = await request.json();
      const session = {
        session_id: body.session_id,
        status: "scheduled",
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        started_at: null,
        last_poll_at: null,
        trigger_distance: body.trigger_distance || 2,
        candidates: body.candidates || [],
        events: [],
        watches: [],
        poll_seconds: body.poll_seconds || 20
      };
      await this.state.storage.put("session", session);
      const now = Date.now();
      await this.state.storage.setAlarm(now + 1e3);
      return json(session);
    }
    if (url.pathname === "/status") {
      const session = await this.state.storage.get("session");
      if (!session) {
        return json({ error: "session_not_found" }, 404);
      }
      return json(session);
    }
    return json({ error: "not_found" }, 404);
  }
  async alarm() {
    const session = await this.state.storage.get("session");
    if (!session) return;
    const next = {
      ...session,
      status: "tracking",
      started_at: session.started_at || (/* @__PURE__ */ new Date()).toISOString(),
      last_poll_at: (/* @__PURE__ */ new Date()).toISOString(),
      events: [
        ...session.events || [],
        {
          type: "worker_poll",
          at: (/* @__PURE__ */ new Date()).toISOString(),
          message: "Mei worker alarm fired."
        }
      ].slice(-50)
    };
    await this.state.storage.put("session", next);
    await this.state.storage.setAlarm(Date.now() + (next.poll_seconds || 20) * 1e3);
  }
};
function json(data, status = 200) {
  return corsResponse(JSON.stringify(data), status, {
    "content-type": "application/json"
  });
}
__name(json, "json");
function corsResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization"
    }
  });
}
__name(corsResponse, "corsResponse");

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-NXQ7HT/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-NXQ7HT/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  MeiSession,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
