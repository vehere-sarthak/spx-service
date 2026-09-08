# spx-service

SpiderX backend API. Express + TypeScript over HTTPS on **:8082** — the same port
and deployment shape as `uiservice`.

This repo is independent of `spx-ui`. The two are coupled only at runtime, over
HTTPS, exactly as `uiServices` couples to `vehere-ui`.

## Configuration

**This service has no config file.** `spx-ui` owns `spiderx.yml` and serves it
from `GET /api/spiderx-configuration`. On startup — before binding — this service
fetches it, then refreshes every 2 minutes.

* UI addresses come from `app.ip` in `/usr/local/etc/setup_info.json`, falling
  back to `127.0.0.1`.
* The payload is AES-256-CBC encrypted with a key derived from the caller's
  `X-Meta-Time`; the IV returns in `X-Meta-IV`.
* If `spx-ui` is unreachable the service still starts on built-in defaults and
  keeps retrying on the refresh timer. `GET /api/v1/system/config` reports which
  source is in effect.

TLS material is read from disk rather than the payload, so HTTPS works even when
`spx-ui` is down:

```
/usr/local/share/ca-certificates/VEHERE.crt
/usr/local/share/ca-certificates/VEHERE.key
```

Override with `SPIDERX_SSL_CERT` / `SPIDERX_SSL_KEY`. Missing certs fall back to HTTP.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/health/live` | liveness, touches nothing |
| `GET /api/v1/health/ready` | ES/MySQL/TLS configuration state |
| `GET /api/v1/system/config` | effective config, secrets stripped |
| `GET /api/v1/system/about` | build metadata |

Application routes migrate out of `spx-ui`'s Next handlers into `src/routes/`,
registered in `src/providers/AppRoutes.ts`.

## Layout

Mirrors `uiServices/src`:

```
src/
├── app.ts                  entry: load config → start server → refresh timer
├── providers/              Config, ConfigService, Server, AppRoutes, ProcessEvents
├── middlewares/            CORS, SecurityHeaders
├── errors/                 HttpCode, ApiError, ErrorHandlerService
├── routes/                 HealthRoutes, SystemRoutes
├── controllers/            HealthController, SystemController
└── utils/                  cryptoUtils
```

## Develop

```bash
npm install
npm run dev        # ts-node-dev, :8082 — start spx-ui first
```

## Build and package

```bash
npm run build      # → dist/app.js + buildInfo.txt
./debBuild.sh      # → spx-service.deb
sudo dpkg -i spx-service.deb
```

Installs to `/usr/local/lib/spx-service/`, bundles its own Node under `node/`,
registers `spx-service.service`, and drops a shim at `/usr/local/bin/spx-service`.
