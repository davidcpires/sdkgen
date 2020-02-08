import { generateDartClientSource } from "@sdkgen/dart-generator";
import { AstJson, ThrowsAnnotation } from "@sdkgen/parser";
import { PLAYGROUND_PUBLIC_PATH } from "@sdkgen/playground";
import {
    generateBrowserClientSource,
    generateNodeClientSource,
    generateNodeServerSource,
} from "@sdkgen/typescript-generator";
import { randomBytes } from "crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { hostname } from "os";
import { getClientIp } from "request-ip";
import staticFilesHandler from "serve-handler";
import { parse as parseUrl } from "url";
import { BaseApiConfig } from "./api-config";
import { Context, ContextReply, ContextRequest } from "./context";
import { decode, encode } from "./encode-decode";

export class SdkgenHttpServer<ExtraContextT = {}> {
    public httpServer: Server;

    private headers = new Map<string, string>();

    private handlers: Array<{
        method: string;
        matcher: string | RegExp;
        handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
    }> = [];

    public dynamicCorsOrigin = true;

    private ignoredUrlPrefix = "";

    constructor(protected apiConfig: BaseApiConfig<ExtraContextT>, private extraContext: ExtraContextT) {
        this.httpServer = createServer(this.handleRequest.bind(this));
        this.enableCors();

        this.addHttpHandler("GET", "/targets/node/api.ts", (req, res) => {
            try {
                res.setHeader("Content-Type", "application/octet-stream");
                res.write(generateNodeServerSource(apiConfig.ast, {}));
            } catch (e) {
                console.error(e);
                res.statusCode = 500;
                res.write(e.toString());
            }

            res.end();
        });

        this.addHttpHandler("GET", "/targets/node/client.ts", (req, res) => {
            try {
                res.setHeader("Content-Type", "application/octet-stream");
                res.write(generateNodeClientSource(apiConfig.ast, {}));
            } catch (e) {
                console.error(e);
                res.statusCode = 500;
                res.write(e.toString());
            }

            res.end();
        });

        this.addHttpHandler("GET", "/targets/web/client.ts", (req, res) => {
            try {
                res.setHeader("Content-Type", "application/octet-stream");
                res.write(generateBrowserClientSource(apiConfig.ast, {}));
            } catch (e) {
                console.error(e);
                res.statusCode = 500;
                res.write(e.toString());
            }

            res.end();
        });

        this.addHttpHandler("GET", "/targets/flutter/client.dart", (req, res) => {
            try {
                res.setHeader("Content-Type", "application/octet-stream");
                res.write(generateDartClientSource(apiConfig.ast, {}));
            } catch (e) {
                console.error(e);
                res.statusCode = 500;
                res.write(e.toString());
            }

            res.end();
        });

        this.addHttpHandler("GET", /^\/playground/u, (req, res) => {
            if (req.url) {
                req.url = req.url.endsWith("/playground")
                    ? req.url.replace(/\/playground/u, "/index.html")
                    : req.url.replace(/\/playground/u, "");
            }

            staticFilesHandler(req, res, {
                cleanUrls: false,
                directoryListing: false,
                etag: true,
                public: PLAYGROUND_PUBLIC_PATH,
            }).catch(e => {
                console.error(e);
                res.statusCode = 500;
                res.write(e.toString());
                res.end();
            });
        });

        this.addHttpHandler("GET", "/ast.json", (req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.write(JSON.stringify(apiConfig.astJson));
            res.end();
        });
    }

    ignoreUrlPrefix(urlPrefix: string) {
        this.ignoredUrlPrefix = urlPrefix;
    }

    listen(port = 8000) {
        this.httpServer.listen(port, () => {
            const addr = this.httpServer.address();
            const addrString = addr === null ? "???" : typeof addr === "string" ? addr : `${addr.address}:${addr.port}`;

            console.log(`Listening on ${addrString}`);
        });
    }

    close() {
        this.httpServer.close();
    }

    private enableCors() {
        this.addHeader("Access-Control-Allow-Methods", "DELETE, HEAD, PUT, POST, PATCH, GET, OPTIONS");
        this.addHeader("Access-Control-Allow-Headers", "Content-Type");
        this.addHeader("Access-Control-Max-Age", "86400");
    }

    addHeader(header: string, value: string) {
        const cleanHeader = header.toLowerCase().trim();
        const existing = this.headers.get(cleanHeader);

        if (existing) {
            this.headers.set(cleanHeader, `${existing}, ${value}`);
        } else {
            this.headers.set(cleanHeader, value);
        }
    }

    addHttpHandler(
        method: string,
        matcher: string | RegExp,
        handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
    ) {
        this.handlers.push({ handler, matcher, method });
    }

    private findBestHandler(path: string, req: IncomingMessage) {
        const matchingHandlers = this.handlers
            .filter(({ method }) => method === req.method)
            .filter(({ matcher }) => {
                if (typeof matcher === "string") {
                    return matcher === path;
                }

                return path.search(matcher) === 0;
            })
            .sort(({ matcher: first }, { matcher: second }) => {
                if (typeof first === "string" && typeof second === "string") {
                    return 0;
                } else if (typeof first === "string") {
                    return -1;
                } else if (typeof second === "string") {
                    return 1;
                }

                const firstMatch = path.match(first);
                const secondMatch = path.match(second);

                return (secondMatch?.[0]?.length ?? 0) - (firstMatch?.[0]?.length ?? 0);
            });

        return matchingHandlers.length ? matchingHandlers[0] : null;
    }

    private handleRequest(req: IncomingMessage, res: ServerResponse) {
        const hrStart = process.hrtime();

        req.on("error", err => {
            console.error(err);
            res.end();
        });

        res.on("error", err => {
            console.error(err);
            res.end();
        });

        if (this.dynamicCorsOrigin && req.headers.origin) {
            res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
            res.setHeader("Vary", "Origin");
        }

        for (const [header, value] of this.headers) {
            if (req.method === "OPTIONS" && !header.startsWith("access-control-")) {
                continue;
            }

            res.setHeader(header, value);
        }

        if (req.method === "OPTIONS") {
            res.writeHead(200);
            res.end();
            return;
        }

        let body = "";

        req.on("data", chunk => (body += chunk.toString()));
        req.on("end", async () =>
            this.handleRequestWithBody(req, res, body, hrStart).catch(e =>
                this.writeReply(res, null, { error: e }, hrStart),
            ),
        );
    }

    private fatalError(message: string) {
        try {
            throw this.apiConfig.err.Fatal(message);
        } catch (fatal) {
            return fatal;
        }
    }

    private log(message: string) {
        console.log(`${new Date().toISOString()} ${message}`);
    }

    private async handleRequestWithBody(
        req: IncomingMessage,
        res: ServerResponse,
        body: string,
        hrStart: [number, number],
    ) {
        let path = parseUrl(req.url || "").pathname || "";

        if (path.startsWith(this.ignoredUrlPrefix)) {
            path = path.slice(this.ignoredUrlPrefix.length);
        }

        const externalHandler = this.findBestHandler(path, req);

        if (externalHandler) {
            this.log(`HTTP ${req.method} ${path}`);
            externalHandler.handler(req, res, body);
            return;
        }

        res.setHeader("Content-Type", "application/json; charset=utf-8");

        if (req.method === "HEAD") {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method === "GET") {
            let ok: boolean;

            try {
                ok = await this.apiConfig.hook.onHealthCheck();
            } catch (e) {
                ok = false;
            }

            res.writeHead(ok ? 200 : 500);
            res.write(JSON.stringify({ ok }));
            res.end();
            return;
        }

        if (req.method !== "POST") {
            res.writeHead(400);
            res.end();
            return;
        }

        const clientIp = getClientIp(req);

        if (!clientIp) {
            this.writeReply(
                res,
                null,
                {
                    error: this.fatalError("Couldn't determine client IP"),
                },
                hrStart,
            );
            return;
        }

        const request = this.parseRequest(req, body, clientIp);

        if (!request) {
            this.writeReply(
                res,
                null,
                {
                    error: this.fatalError("Couldn't parse request"),
                },
                hrStart,
            );
            return;
        }

        const ctx: Context & ExtraContextT = {
            ...this.extraContext,
            request,
        };

        const functionDescription = this.apiConfig.astJson.functionTable[ctx.request.name] as
            | AstJson["functionTable"]["fn"]
            | undefined;
        const functionImplementation = this.apiConfig.fn[ctx.request.name];

        if (!functionDescription || !functionImplementation) {
            this.writeReply(
                res,
                ctx,
                {
                    error: this.fatalError(`Function does not exist: ${ctx.request.name}`),
                },
                hrStart,
            );
            return;
        }

        let reply: ContextReply | null;

        try {
            reply = await this.apiConfig.hook.onRequestStart(ctx);
            if (!reply) {
                const args = decode(
                    this.apiConfig.astJson.typeTable,
                    `${ctx.request.name}.args`,
                    functionDescription.args,
                    ctx.request.args,
                );
                const ret = await functionImplementation(ctx, args);
                const encodedRet = encode(
                    this.apiConfig.astJson.typeTable,
                    `${ctx.request.name}.ret`,
                    functionDescription.ret,
                    ret,
                );

                reply = { result: encodedRet };
            }
        } catch (e) {
            reply = {
                error: e,
            };
        }

        reply = (await this.apiConfig.hook.onRequestEnd(ctx, reply)) || reply;

        // If errors, check if the error type is one of the @throws annotation. If it isn't, change to Fatal
        if (reply.error) {
            const functionAst = this.apiConfig.ast.operations.find(op => op.name === ctx.request.name);

            if (functionAst) {
                const allowedErrors = functionAst.annotations
                    .filter(ann => ann instanceof ThrowsAnnotation)
                    .map(ann => (ann as ThrowsAnnotation).error);

                if (allowedErrors.length > 0) {
                    if (!allowedErrors.includes(reply.error.type)) {
                        reply.error.type = "Fatal";
                    }
                }
            }
        }

        this.writeReply(res, ctx, reply, hrStart);
    }

    private parseRequest(req: IncomingMessage, body: string, ip: string): ContextRequest | null {
        switch (this.identifyRequestVersion(req, body)) {
            case 1:
                return this.parseRequestV1(req, body, ip);
            case 2:
                return this.parseRequestV2(req, body, ip);
            case 3:
                return this.parseRequestV3(req, body, ip);
            default:
                throw new Error("Failed to understand request");
        }
    }

    private identifyRequestVersion(req: IncomingMessage, body: string): number {
        const parsed = JSON.parse(body);

        if ("version" in parsed) {
            return parsed.version;
        } else if ("requestId" in parsed) {
            return 2;
        } else if ("device" in parsed) {
            return 1;
        }

        return 3;
    }

    // Old Sdkgen format
    private parseRequestV1(req: IncomingMessage, body: string, ip: string): ContextRequest {
        const parsed = decode(
            {
                Request: {
                    args: "json",
                    device: {
                        id: "string?",
                        language: "string?",
                        platform: "json?",
                        timezone: "string?",
                        type: "string?",
                        version: "string?",
                    },
                    id: "string",
                    name: "string",
                },
            },
            "root",
            "Request",
            JSON.parse(body),
        );

        return {
            args: parsed.args,
            deviceInfo: {
                id: parsed.device.id || parsed.id,
                language: parsed.device.language,
                platform: parsed.device.platform,
                timezone: parsed.device.timezone,
                type: parsed.device.type || parsed.device.platform || "",
                version: parsed.device.version,
            },
            extra: {},
            headers: req.headers,
            id: parsed.id,
            ip,
            name: parsed.name,
            version: 1,
        };
    }

    // Maxima sdkgen format
    private parseRequestV2(req: IncomingMessage, body: string, ip: string): ContextRequest {
        const parsed = decode(
            {
                Request: {
                    args: "json",
                    deviceId: "string",
                    info: {
                        browserUserAgent: "string?",
                        language: "string",
                        type: "string",
                    },
                    name: "string",
                    partnerId: "string?",
                    requestId: "string",
                    sessionId: "string?",
                },
            },
            "root",
            "Request",
            JSON.parse(body),
        );

        return {
            args: parsed.args,
            deviceInfo: {
                id: parsed.deviceId,
                language: parsed.info.language,
                platform: {
                    browserUserAgent: parsed.info.browserUserAgent || null,
                },
                timezone: null,
                type: parsed.info.type,
                version: "",
            },
            extra: {
                partnerId: parsed.partnerId,
                sessionId: parsed.sessionId,
            },
            headers: req.headers,
            id: parsed.requestId,
            ip,
            name: parsed.name,
            version: 2,
        };
    }

    // New sdkgen format
    private parseRequestV3(req: IncomingMessage, body: string, ip: string): ContextRequest {
        const parsed = decode(
            {
                DeviceInfo: {
                    browserUserAgent: "string?",
                    id: "string?",
                    language: "string?",
                    platform: "json?",
                    timezone: "string?",
                    type: "string?",
                    version: "string?",
                },
                Request: {
                    args: "json",
                    deviceInfo: "DeviceInfo?",
                    extra: "json?",
                    name: "string",
                    requestId: "string?",
                },
            },
            "root",
            "Request",
            JSON.parse(body),
        );

        const deviceInfo = parsed.deviceInfo || {};

        return {
            args: parsed.args,
            deviceInfo: {
                id: deviceInfo.id || randomBytes(16).toString("hex"),
                language: deviceInfo.language || null,
                platform: {
                    ...(deviceInfo.platform ?? {}),
                    browserUserAgent: deviceInfo.browserUserAgent || null,
                },
                timezone: deviceInfo.timezone || null,
                type: deviceInfo.type || "api",
                version: deviceInfo.version || null,
            },
            extra: parsed.extra ? { ...parsed.extra } : {},
            headers: req.headers,
            id: parsed.requestId || randomBytes(16).toString("hex"),
            ip,
            name: parsed.name,
            version: 3,
        };
    }

    private makeResponseError(err: { message: string; type: string }) {
        return {
            message: err.message || err.toString(),
            type: err.type || "Fatal",
        };
    }

    private writeReply(res: ServerResponse, ctx: Context | null, reply: ContextReply, hrStart: [number, number]) {
        if (!ctx) {
            res.statusCode = 500;
            res.write(
                JSON.stringify({
                    error: this.makeResponseError(reply?.error ?? this.fatalError("Response without context")),
                }),
            );
            res.end();
            return;
        }

        const deltaTime = process.hrtime(hrStart);
        const duration = deltaTime[0] + deltaTime[1] * 1e-9;

        this.log(
            `${ctx.request.id} [${duration.toFixed(6)}s] ${ctx.request.name}() -> ${
                reply.error ? this.makeResponseError(reply.error).type : "OK"
            }`,
        );

        switch (ctx.request.version) {
            case 1: {
                const response = {
                    deviceId: ctx.request.deviceInfo.id,
                    duration,
                    error: reply.error ? this.makeResponseError(reply.error) : null,
                    host: hostname(),
                    id: ctx.request.id,
                    ok: !reply.error,
                    result: reply.error ? null : reply.result,
                };

                res.statusCode = response.error
                    ? this.makeResponseError(response.error).type === "Fatal"
                        ? 500
                        : 400
                    : 200;
                res.write(JSON.stringify(response));
                res.end();
                break;
            }

            case 2: {
                const response = {
                    deviceId: ctx.request.deviceInfo.id,
                    error: reply.error ? this.makeResponseError(reply.error) : null,
                    ok: !reply.error,
                    requestId: ctx.request.id,
                    result: reply.error ? null : reply.result,
                    sessionId: ctx.request.extra.sessionId,
                };

                res.statusCode = response.error
                    ? this.makeResponseError(response.error).type === "Fatal"
                        ? 500
                        : 400
                    : 200;
                res.write(JSON.stringify(response));
                res.end();
                break;
            }

            case 3: {
                const response = {
                    duration,
                    error: reply.error ? this.makeResponseError(reply.error) : null,
                    host: hostname(),
                    result: reply.error ? null : reply.result,
                };

                res.statusCode = response.error
                    ? this.makeResponseError(response.error).type === "Fatal"
                        ? 500
                        : 400
                    : 200;
                res.setHeader("x-request-id", ctx.request.id);
                res.write(JSON.stringify(response));
                res.end();
                break;
            }

            default: {
                res.statusCode = 500;
                res.write(
                    JSON.stringify({
                        error: this.makeResponseError(reply?.error ?? this.fatalError("Unknown request version")),
                    }),
                );
                res.end();
                return;
            }
        }
    }
}