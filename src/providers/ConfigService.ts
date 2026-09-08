import fs from 'fs';
import https from 'https';
import { decryptJSON } from '../utils/cryptoUtils';

export interface SpiderXConfig {
  elasticsearch_config?: {
    hosts?: string | string[];
    username?: string;
    password?: string;
    requestTimeout?: number;
    rejectUnauthorized?: boolean;
  };
  mySQL_config?: {
    host?: string;
    user?: string;
    password?: string;
    database?: string;
    port?: number;
    connectionLimit?: number;
  };
  server?: { port?: number; bind?: string; preferHttps?: boolean };
  service?: {
    port?: number;
    bind?: string;
    preferHttps?: boolean;
    apiPrefix?: string;
    url?: string;
  };
  auth?: Record<string, unknown>;
  filePath?: { server_ssl_certificate?: string; server_ssl_key?: string; [k: string]: string | undefined };
  dbIndex?: Record<string, string>;
}

const SETUP_INFO_PATH = '/usr/local/etc/setup_info.json';
const DEFAULT_UI_PORT = 4000;
const DEFAULT_CERT = '/usr/local/share/ca-certificates/VEHERE.crt';
const DEFAULT_KEY = '/usr/local/share/ca-certificates/VEHERE.key';

/**
 * spx-ui owns spiderx.yml. This service holds no config file of its own — it
 * pulls the effective config from spx-ui at startup and on a timer, exactly as
 * uiServices pulls /api/ui-configuration from vehere-ui.
 */
class ConfigService {
  private localConfig: SpiderXConfig = {};
  private setupConfig: any = null;
  private loaded = false;

  public get(): SpiderXConfig {
    return this.localConfig;
  }

  public getSetupConfig(): any {
    return this.setupConfig;
  }

  /** True once a fetch from spx-ui has succeeded at least once. */
  public isLoaded(): boolean {
    return this.loaded;
  }

  private uiHosts(): string[] {
    const hosts: string[] = [];
    try {
      if (fs.existsSync(SETUP_INFO_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(SETUP_INFO_PATH, 'utf-8'));
        hosts.push(...(parsed?.app?.ip || []));
      }
    } catch (err) {
      console.warn('[spx-service] setup_info.json unreadable:', (err as Error).message);
    }
    hosts.push('127.0.0.1');
    return hosts;
  }

  /** Fetch + cache the config from spx-ui, trying each known UI address in turn. */
  public fetchConfig = async (): Promise<void> => {
    const uiPort = Number(process.env.SPX_UI_PORT || this.localConfig.server?.port || DEFAULT_UI_PORT);
    const hosts = this.uiHosts();

    for (const host of hosts) {
      try {
        const xMetaTime = String(Math.floor(Date.now() / 1000));
        const body = await this.request(
          `https://${host}:${uiPort}/api/spiderx-configuration`,
          xMetaTime
        );
        const data = decryptJSON(body.data, body.iv, xMetaTime);
        this.localConfig = data.localConfig || {};
        this.setupConfig = data.setupConfig ?? null;
        this.loaded = true;
        return;
      } catch {
        // try the next UI address
      }
    }

    console.warn(
      `\n[spx-service] Could not read config from spx-ui on ${hosts.join(', ')}:${uiPort}. ` +
        `In development add your app server IP under app.ip in ${SETUP_INFO_PATH} and start spx-ui first.`
    );
  };

  private request(url: string, xMetaTime: string): Promise<{ data: string; iv: string }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: 'GET',
          // spx-ui presents the appliance's self-signed VEHERE cert
          rejectUnauthorized: false,
          timeout: 10000,
          headers: { 'X-Meta-Time': xMetaTime },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const iv = (res.headers['x-meta-iv'] || res.headers['X-Meta-IV']) as string;
              if (!json?.data || !iv) {
                reject(new Error('malformed config response'));
                return;
              }
              resolve({ data: json.data, iv });
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('config fetch timeout'));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * TLS material is read from disk, not from the config payload, so the service
   * can still come up over HTTPS when spx-ui is unreachable.
   */
  public sslOptions(): { key: Buffer; cert: Buffer } | null {
    const fp = this.localConfig.filePath || {};
    const cert = process.env.SPIDERX_SSL_CERT || fp.server_ssl_certificate || DEFAULT_CERT;
    const key = process.env.SPIDERX_SSL_KEY || fp.server_ssl_key || DEFAULT_KEY;
    try {
      if (!fs.existsSync(cert) || !fs.existsSync(key)) return null;
      return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
    } catch {
      return null;
    }
  }

  public certPaths() {
    const fp = this.localConfig.filePath || {};
    return {
      cert: process.env.SPIDERX_SSL_CERT || fp.server_ssl_certificate || DEFAULT_CERT,
      key: process.env.SPIDERX_SSL_KEY || fp.server_ssl_key || DEFAULT_KEY,
    };
  }
}

export default new ConfigService();
