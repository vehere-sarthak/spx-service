import { HttpCode } from './HttpCode';

/**
 * Error taxonomy mirrors uiServices/src/errors/ApiError.ts. Only the codes the
 * scaffold needs are defined; extend this enum as routes are migrated over.
 */
export enum CustomErrorCodes {
  E_ES_101, // Elasticsearch error
  E_SQ_101, // MySQL error
  E_CFG_101, // Configuration unavailable
  E_DF_404, // Path not found
  E_RQ_101, // Invalid request body
}

export class ApiError extends Error {
  public statusCode: HttpCode;
  public message: string;
  public details?: unknown;
  public errorType?: CustomErrorCodes;

  constructor(errorType: CustomErrorCodes, error?: any, details?: unknown) {
    super();
    this.errorType = errorType;

    switch (errorType) {
      case CustomErrorCodes.E_ES_101:
        this.statusCode = error?.meta?.statusCode || HttpCode.BAD_GATEWAY;
        this.message = error?.message || 'Elasticsearch error!';
        this.details = error?.meta?.body?.error || details || '';
        break;

      case CustomErrorCodes.E_SQ_101:
        this.statusCode = HttpCode.INTERNAL_SERVER_ERROR;
        this.message = error?.message || 'MySQL error!';
        this.details = details ?? '';
        break;

      case CustomErrorCodes.E_CFG_101:
        this.statusCode = HttpCode.SERVICE_UNAVAILABLE;
        this.message = 'Configuration unavailable!';
        this.details = details ?? '';
        break;

      case CustomErrorCodes.E_DF_404:
        this.statusCode = HttpCode.NOT_FOUND;
        this.message = 'NOT FOUND!';
        this.details = details ?? '';
        break;

      case CustomErrorCodes.E_RQ_101:
        this.statusCode = HttpCode.BAD_REQUEST;
        this.message = 'Invalid request body.';
        this.details = details ?? '';
        break;

      default:
        this.statusCode = HttpCode.INTERNAL_SERVER_ERROR;
        this.message = 'Unknown error originated.';
        this.details = '';
        break;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}

export default ApiError;
