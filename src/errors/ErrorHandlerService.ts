import { Request, Response, NextFunction } from 'express';
import { ApiError, CustomErrorCodes } from './ApiError';
import { HttpCode } from './HttpCode';

class ErrorHandlerService {
  public handleError(err: ApiError, req: Request, res: Response, next: NextFunction) {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json({
        success: false,
        message: err.message,
        statusCode: err.statusCode,
        details: err.details ?? null,
      });
      return;
    }

    console.error('An unexpected error occurred:', err);
    res.status(HttpCode.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: 'Internal Server Error',
      statusCode: HttpCode.INTERNAL_SERVER_ERROR,
    });
  }

  /** Middleware to catch 404s before the general handler. */
  public notFoundHandler(req: Request, res: Response, next: NextFunction) {
    next(new ApiError(CustomErrorCodes.E_DF_404, undefined, req.originalUrl));
  }
}

export default ErrorHandlerService;
