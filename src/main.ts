import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors';
import { config } from './config';

export async function createApp() {
  const cfg = config();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: cfg.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'] });
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '100kb' });
  app.enableCors({ origin: cfg.WEB_ORIGIN.split(','), credentials: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  return app;
}

if (require.main === module) {
  createApp().then(async (app) => {
    await app.listen(config().PORT, '0.0.0.0');
    console.log(`Tinbit API listening on :${config().PORT} (demo mode: ${config().DEMO_MODE})`);
  });
}
