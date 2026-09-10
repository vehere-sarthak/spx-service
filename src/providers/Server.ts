import { type Server as ServerHttp, type IncomingMessage, type ServerResponse } from 'http';
import http from 'http';
import https from 'https';
import path from 'path';
import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import CORS from '../middlewares/CORS';
import SecurityHeaders from '../middlewares/SecurityHeaders';
import requireSession from '../middlewares/RequireSession';
import ErrorHandlerService from '../errors/ErrorHandlerService';
import ApiError from '../errors/ApiError';
import ConfigService from './ConfigService';

interface ServerOptions {
  port: number | string;
  bind: string;
  routes: Router;
  apiPrefix: string;
}

export class Server {
  public readonly app = express();
  private serverListener?: ServerHttp<typeof IncomingMessage, typeof ServerResponse>;
  private readonly port: number;
  private readonly bind: string;
  private readonly routes: Router;
  private readonly apiPrefix: string;

  constructor(options: ServerOptions) {
    this.port = typeof options.port === 'string' ? parseInt(options.port, 10) : options.port;
    this.bind = options.bind;
    this.routes = options.routes;
    this.apiPrefix = options.apiPrefix;
  }

  async start(): Promise<void> {
    // Body parsers — same generous limits as uiServices, PCAP/hex payloads are large.
    this.app.use(express.json({ limit: '500mb' }));
    this.app.use(express.urlencoded({ limit: '500mb', extended: true }));

    this.app.use(compression());
    this.app.use(cookieParser());

    this.app.use((req, res, next) => CORS.applyCorsOptions(req, res, next));
    this.app.use((req, res, next) => SecurityHeaders.applyHelmetOptions(req, res, next));
    this.app.use((req, res, next) => SecurityHeaders.applyNoCache(req, res, next));

    this.app.get('/', (req: Request, res: Response) => {
      res.send('SpiderX backend is running');
    });

    this.app.use('/public', express.static(path.join(process.cwd(), 'public')));

    // Route endpoints mounted under the API prefix. The session gate sits in
    // front of them, so a route is protected by default and has to be named in
    // RequireSession's allowlist to be reachable without logging in.
    this.app.use(this.apiPrefix, requireSession, this.routes);

    // Error handlers, last
    const errorHandlerService = new ErrorHandlerService();
    this.app.use((req, res, next) => errorHandlerService.notFoundHandler(req, res, next));
    this.app.use((err: ApiError, req: Request, res: Response, next: NextFunction) =>
      errorHandlerService.handleError(err, req, res, next)
    );

    const preferHttps = ConfigService.get().service?.preferHttps !== false;
    const ssl = ConfigService.sslOptions();

    if (ssl && preferHttps) {
      this.serverListener = https
        .createServer(ssl, this.app)
        .listen(this.port, this.bind, () => {
          console.log(`[spx-service] HTTPS https://${this.bind}:${this.port}${this.apiPrefix}`);
          console.log(`[spx-service] cert ${ConfigService.certPaths().cert}`);
        });
      return;
    }

    console.warn(
      '[spx-service] SSL cert/key missing — starting HTTP (set VEHERE.crt/key or SPIDERX_SSL_*)'
    );
    this.serverListener = http.createServer(this.app).listen(this.port, this.bind, () => {
      console.log(`[spx-service] HTTP http://${this.bind}:${this.port}${this.apiPrefix}`);
    });
  }

  public stop(): void {
    this.serverListener?.close();
  }
}
