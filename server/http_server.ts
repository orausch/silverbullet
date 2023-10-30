import { Application, Context, Next, oakCors, Router } from "./deps.ts";
import { SpacePrimitives } from "../common/spaces/space_primitives.ts";
import { AssetBundle } from "../plugos/asset_bundle/bundle.ts";
import { ensureSettingsAndIndex } from "../common/util.ts";
import { BuiltinSettings } from "../web/types.ts";
import { gitIgnoreCompiler } from "./deps.ts";
import { cyan, format, green, red, yellow } from "./deps.ts";
import { FilteredSpacePrimitives } from "../common/spaces/filtered_space_primitives.ts";
import { Authenticator } from "./auth.ts";
import { FileMeta } from "$sb/types.ts";
import {
  ShellRequest,
  ShellResponse,
  SyscallRequest,
  SyscallResponse,
} from "./rpc.ts";
import { SilverBulletHooks } from "../common/manifest.ts";
import { System } from "../plugos/system.ts";

export type ServerOptions = {
  hostname: string;
  port: number;
  pagesPath: string;
  clientAssetBundle: AssetBundle;
  authenticator: Authenticator;
  pass?: string;
  certFile?: string;
  keyFile?: string;
};

// inspired by https://github.com/Daggy1234/Oak-Logger
const logger = async (
  { response, request }: { response: any; request: any },
  next: Function,
) => {
  await next();
  const status: number = response.status;
  const log_string: string = `[${
    format(new Date(Date.now()), "MM-dd-yyyy hh:mm:ss.SSS")
  }  Oak::logger] ${request.ip} "${request.method} ${request.url.pathname}" ${
    String(status)
  }`;
  var color = status >= 500
    ? console.log(`${red(log_string)}`) // red
    : status >= 400
    ? console.log(`${yellow(log_string)}`) // yellow
    : status >= 300
    ? console.log(`${cyan(log_string)}`) // cyan
    : status >= 200
    ? console.log(`${green(log_string)}`) // green
    : console.log(`${red(log_string)}`);
};

export class HttpServer {
  private hostname: string;
  private port: number;
  abortController?: AbortController;
  clientAssetBundle: AssetBundle;
  settings?: BuiltinSettings;
  spacePrimitives: SpacePrimitives;
  authenticator: Authenticator;

  constructor(
    spacePrimitives: SpacePrimitives,
    private app: Application,
    private system: System<SilverBulletHooks> | undefined,
    private options: ServerOptions,
  ) {
    this.hostname = options.hostname;
    this.port = options.port;
    this.authenticator = options.authenticator;
    this.clientAssetBundle = options.clientAssetBundle;

    let fileFilterFn: (s: string) => boolean = () => true;
    this.spacePrimitives = new FilteredSpacePrimitives(
      spacePrimitives,
      (meta) => fileFilterFn(meta.name),
      async () => {
        await this.reloadSettings();
        if (typeof this.settings?.spaceIgnore === "string") {
          fileFilterFn = gitIgnoreCompiler(this.settings.spaceIgnore).accepts;
        } else {
          fileFilterFn = () => true;
        }
      },
    );
  }

  // Replaces some template variables in index.html in a rather ad-hoc manner, but YOLO
  renderIndexHtml() {
    return this.clientAssetBundle.readTextFileSync(".client/index.html")
      .replaceAll(
        "{{SPACE_PATH}}",
        this.options.pagesPath.replaceAll("\\", "\\\\"),
        // );
      ).replaceAll(
        "{{SYNC_ONLY}}",
        this.system ? "false" : "true",
      );
  }

  async start() {
    await this.reloadSettings();

    // Setup request logging
    this.app.use(logger);

    // Serve static files (javascript, css, html)
    this.app.use(this.serveStatic.bind(this));

    await this.addPasswordAuth(this.app);
    const fsRouter = this.addFsRoutes(this.spacePrimitives);
    this.app.use(fsRouter.routes());
    this.app.use(fsRouter.allowedMethods());

    // Fallback, serve the UI index.html
    this.app.use(({ response }) => {
      response.headers.set("Content-type", "text/html");
      response.body = this.renderIndexHtml();
    });

    this.abortController = new AbortController();
    const listenOptions: any = {
      hostname: this.hostname,
      port: this.port,
      signal: this.abortController.signal,
    };
    if (this.options.keyFile) {
      listenOptions.key = Deno.readTextFileSync(this.options.keyFile);
    }
    if (this.options.certFile) {
      listenOptions.cert = Deno.readTextFileSync(this.options.certFile);
    }
    this.app.listen(listenOptions)
      .catch((e: any) => {
        console.log("Server listen error:", e.message);
        Deno.exit(1);
      });
    const visibleHostname = this.hostname === "0.0.0.0"
      ? "localhost"
      : this.hostname;
    console.log(
      `SilverBullet is now running: http://${visibleHostname}:${this.port}`,
    );
  }

  serveStatic(
    { request, response }: Context<Record<string, any>, Record<string, any>>,
    next: Next,
  ) {
    if (
      request.url.pathname === "/"
    ) {
      // Serve the UI (index.html)
      // Note: we're explicitly not setting Last-Modified and If-Modified-Since header here because this page is dynamic
      response.headers.set("Content-type", "text/html");
      response.body = this.renderIndexHtml();
      return;
    }
    try {
      const assetName = request.url.pathname.slice(1);
      if (
        this.clientAssetBundle.has(assetName) &&
        request.headers.get("If-Modified-Since") ===
          utcDateString(this.clientAssetBundle.getMtime(assetName))
      ) {
        response.status = 304;
        return;
      }
      response.status = 200;
      response.headers.set(
        "Content-type",
        this.clientAssetBundle.getMimeType(assetName),
      );
      const data = this.clientAssetBundle.readFileSync(
        assetName,
      );
      response.headers.set("Cache-Control", "no-cache");
      response.headers.set("Content-length", "" + data.length);
      response.headers.set(
        "Last-Modified",
        utcDateString(this.clientAssetBundle.getMtime(assetName)),
      );

      if (request.method === "GET") {
        response.body = data;
      }
    } catch {
      return next();
    }
  }

  async reloadSettings() {
    // TODO: Throttle this?
    this.settings = await ensureSettingsAndIndex(this.spacePrimitives);
  }

  private async addPasswordAuth(app: Application) {
    const excludedPaths = [
      "/manifest.json",
      "/favicon.png",
      "/logo.png",
      "/.auth",
    ];

    // Middleware handling the /.auth page and flow
    app.use(async ({ request, response, cookies }, next) => {
      const host = request.url.host; // e.g. localhost:3000
      if (request.url.pathname === "/.auth") {
        if (request.url.search === "?logout") {
          await cookies.delete(authCookieName(host));
          // Implicit fallthrough to login page
        }
        if (request.method === "GET") {
          response.headers.set("Content-type", "text/html");
          response.body = this.clientAssetBundle.readTextFileSync(
            ".client/auth.html",
          );
          return;
        } else if (request.method === "POST") {
          const values = await request.body({ type: "form" }).value;
          const username = values.get("username")!,
            password = values.get("password")!,
            refer = values.get("refer");
          const hashedPassword = await this.authenticator.authenticate(
            username,
            password,
          );
          if (hashedPassword) {
            await cookies.set(
              authCookieName(host),
              `${username}:${hashedPassword}`,
              {
                expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7), // in a week
                sameSite: "strict",
              },
            );
            response.redirect(refer || "/");
            // console.log("All headers", request.headers);
          } else {
            response.redirect("/.auth?error=1");
          }
          return;
        } else {
          response.redirect("/.auth");
          return;
        }
      } else {
        await next();
      }
    });

    if ((await this.authenticator.getAllUsers()).length > 0) {
      // Users defined, so enabling auth
      app.use(async ({ request, response, cookies }, next) => {
        const host = request.url.host;
        if (!excludedPaths.includes(request.url.pathname)) {
          const authCookie = await cookies.get(authCookieName(host));
          if (!authCookie) {
            response.redirect("/.auth");
            return;
          }
          const [username, hashedPassword] = authCookie.split(":");
          if (
            !await this.authenticator.authenticateHashed(
              username,
              hashedPassword,
            )
          ) {
            response.redirect("/.auth");
            return;
          }
        }
        await next();
      });
    }
  }

  private addFsRoutes(spacePrimitives: SpacePrimitives): Router {
    const fsRouter = new Router();
    const corsMiddleware = oakCors({
      allowedHeaders: "*",
      exposedHeaders: "*",
      methods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
    });

    fsRouter.use(corsMiddleware);

    // File list
    fsRouter.get(
      "/index.json",
      // corsMiddleware,
      async ({ request, response }) => {
        if (request.headers.has("X-Sync-Mode")) {
          // Only handle direct requests for a JSON representation of the file list
          response.headers.set("Content-type", "application/json");
          response.headers.set("X-Space-Path", this.options.pagesPath);
          const files = await spacePrimitives.fetchFileList();
          response.body = JSON.stringify(files);
        } else {
          // Otherwise, redirect to the UI
          // The reason to do this is to handle authentication systems like Authelia nicely
          response.redirect("/");
        }
      },
    );

    // RPC
    fsRouter.post("/.rpc", async ({ request, response }) => {
      const body = await request.body({ type: "json" }).value;
      try {
        switch (body.operation) {
          case "shell": {
            // TODO: Have a nicer way to do this
            if (this.options.pagesPath.startsWith("s3://")) {
              response.status = 500;
              response.body = JSON.stringify({
                stdout: "",
                stderr: "Cannot run shell commands with S3 backend",
                code: 500,
              });
              return;
            }
            const shellCommand: ShellRequest = body;
            console.log(
              "Running shell command:",
              shellCommand.cmd,
              shellCommand.args,
            );
            const p = new Deno.Command(shellCommand.cmd, {
              args: shellCommand.args,
              cwd: this.options.pagesPath,
              stdout: "piped",
              stderr: "piped",
            });
            const output = await p.output();
            const stdout = new TextDecoder().decode(output.stdout);
            const stderr = new TextDecoder().decode(output.stderr);

            response.headers.set("Content-Type", "application/json");
            response.body = JSON.stringify({
              stdout,
              stderr,
              code: output.code,
            } as ShellResponse);
            if (output.code !== 0) {
              console.error("Error running shell command", stdout, stderr);
            }
            return;
          }
          case "syscall": {
            if (!this.system) {
              response.headers.set("Content-Type", "text/plain");
              response.status = 400;
              response.body = "Unknown operation";
              return;
            }
            const syscallCommand: SyscallRequest = body;
            try {
              const plug = this.system.loadedPlugs.get(syscallCommand.ctx);
              if (!plug) {
                throw new Error(`Plug ${syscallCommand.ctx} not found`);
              }
              const result = await plug.syscall(
                syscallCommand.name,
                syscallCommand.args,
              );
              response.headers.set("Content-type", "application/json");
              response.status = 200;
              response.body = JSON.stringify({
                result: result,
              } as SyscallResponse);
            } catch (e: any) {
              response.headers.set("Content-type", "application/json");
              response.status = 500;
              response.body = JSON.stringify({
                error: e.message,
              } as SyscallResponse);
            }
            return;
          }
          default:
            response.headers.set("Content-Type", "text/plain");
            response.status = 400;
            response.body = "Unknown operation";
        }
      } catch (e: any) {
        console.log("Error", e);
        response.status = 500;
        response.body = e.message;
        return;
      }
    });

    const filePathRegex = "\/([^!].+\\.[a-zA-Z]+)";

    fsRouter
      .get(
        filePathRegex,
        async ({ params, response, request }) => {
          const name = params[0];
          console.log("Requested file", name);
          if (!request.headers.has("X-Sync-Mode") && name.endsWith(".md")) {
            // It can happen that during a sync, authentication expires, this may result in a redirect to the login page and then back to this particular file. This particular file may be an .md file, which isn't great to show so we're redirecting to the associated SB UI page.
            console.log("Request was without X-Sync-Mode, redirecting to page");
            response.redirect(`/${name.slice(0, -3)}`);
            return;
          }
          if (name.startsWith(".")) {
            // Don't expose hidden files
            response.status = 404;
            response.body = "Not exposed";
            return;
          }
          // Handle federated links through a simple redirect, only used for attachments loads with service workers disabled
          if (name.startsWith("!")) {
            let url = name.slice(1);
            if (url.startsWith("localhost")) {
              url = `http://${url}`;
            } else {
              url = `https://${url}`;
            }
            try {
              const req = await fetch(url);
              response.status = req.status;
              // Override X-Permssion header to always be "ro"
              const newHeaders = new Headers();
              for (const [key, value] of req.headers.entries()) {
                newHeaders.set(key, value);
              }
              newHeaders.set("X-Permission", "ro");
              response.headers = newHeaders;
              response.body = req.body;
            } catch (e: any) {
              console.error("Error fetching federated link", e);
              response.status = 500;
              response.body = e.message;
            }
            return;
          }
          try {
            if (request.headers.has("X-Get-Meta")) {
              // Getting meta via GET request
              const fileData = await spacePrimitives.getFileMeta(name);
              response.status = 200;
              this.fileMetaToHeaders(response.headers, fileData);
              response.body = "";
              return;
            }
            const fileData = await spacePrimitives.readFile(name);
            const lastModifiedHeader = new Date(fileData.meta.lastModified)
              .toUTCString();
            if (
              request.headers.get("If-Modified-Since") === lastModifiedHeader
            ) {
              response.status = 304;
              return;
            }
            response.status = 200;
            this.fileMetaToHeaders(response.headers, fileData.meta);
            response.headers.set("Last-Modified", lastModifiedHeader);

            response.body = fileData.data;
          } catch (e: any) {
            console.error("Error GETting file", name, e.message);
            response.status = 404;
            response.body = "Not found";
          }
        },
      )
      .put(
        filePathRegex,
        async ({ request, response, params }) => {
          const name = params[0];
          console.log("Saving file", name);
          if (name.startsWith(".")) {
            // Don't expose hidden files
            response.status = 403;
            return;
          }

          const body = await request.body({ type: "bytes" }).value;

          try {
            const meta = await spacePrimitives.writeFile(
              name,
              body,
            );
            response.status = 200;
            this.fileMetaToHeaders(response.headers, meta);
            response.body = "OK";
          } catch (err) {
            console.error("Write failed", err);
            response.status = 500;
            response.body = "Write failed";
          }
        },
      )
      .delete(filePathRegex, async ({ response, params }) => {
        const name = params[0];
        console.log("Deleting file", name);
        if (name.startsWith(".")) {
          // Don't expose hidden files
          response.status = 403;
          return;
        }
        try {
          await spacePrimitives.deleteFile(name);
          response.status = 200;
          response.body = "OK";
        } catch (e: any) {
          console.error("Error deleting attachment", e);
          response.status = 500;
          response.body = e.message;
        }
      })
      .options(filePathRegex, corsMiddleware);

    const proxyPathRegex = "\/!(.+)";
    fsRouter.all(proxyPathRegex, async ({ params, response, request }) => {
      let url = params[0];
      console.log("Requested path to proxy", url, request.method);
      if (url.startsWith("localhost")) {
        url = `http://${url}`;
      } else {
        url = `https://${url}`;
      }
      try {
        const safeRequestHeaders = new Headers();
        for (const headerName of ["Authorization", "Accept", "Content-Type"]) {
          if (request.headers.has(headerName)) {
            safeRequestHeaders.set(
              headerName,
              request.headers.get(headerName)!,
            );
          }
        }
        const req = await fetch(url, {
          method: request.method,
          headers: safeRequestHeaders,
          body: request.hasBody
            ? request.body({ type: "stream" }).value
            : undefined,
        });
        response.status = req.status;
        // // Override X-Permssion header to always be "ro"
        // const newHeaders = new Headers();
        // for (const [key, value] of req.headers.entries()) {
        //   newHeaders.set(key, value);
        // }
        // newHeaders.set("X-Permission", "ro");
        response.headers = req.headers;
        response.body = req.body;
      } catch (e: any) {
        console.error("Error fetching federated link", e);
        response.status = 500;
        response.body = e.message;
      }
      return;
    });
    return fsRouter;
  }

  private fileMetaToHeaders(headers: Headers, fileMeta: FileMeta) {
    headers.set("Content-Type", fileMeta.contentType);
    headers.set(
      "X-Last-Modified",
      "" + fileMeta.lastModified,
    );
    headers.set("Cache-Control", "no-cache");
    headers.set("X-Permission", fileMeta.perm);
    headers.set("X-Content-Length", "" + fileMeta.size);
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort();
      console.log("stopped server");
    }
  }
}

function utcDateString(mtime: number): string {
  return new Date(mtime).toUTCString();
}

function authCookieName(host: string) {
  return `auth:${host}`;
}
