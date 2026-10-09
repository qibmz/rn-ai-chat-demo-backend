import { utilities as nestWinstonModuleUtilities } from 'nest-winston';
import * as winston from 'winston';

export function createWinstonConfig() {
  const isProd = process.env.NODE_ENV === 'production';
  const appName = process.env.APP_NAME?.trim() || 'App';

  return {
    transports: [
      new winston.transports.Console({
        level: isProd ? 'info' : 'debug',
        format: isProd
          ? winston.format.combine(
              winston.format.timestamp(),
              winston.format.errors({ stack: true }),
              winston.format.json(),
            )
          : winston.format.combine(
              winston.format.timestamp(),
              winston.format.ms(),
              nestWinstonModuleUtilities.format.nestLike(appName, {
                colors: true,
                prettyPrint: true,
              }),
            ),
      }),
    ],
  };
}
