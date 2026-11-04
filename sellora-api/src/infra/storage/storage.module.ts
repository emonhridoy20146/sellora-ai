import { Global, Logger, Module } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppConfig } from '../../config/app-config.js';
import { LocalStorageDriver } from './local.driver.js';
import { S3StorageDriver } from './s3.driver.js';
import { UrlSigner } from './signing.js';
import { StorageDriver } from './storage.driver.js';

function signerFor(config: AppConfig): UrlSigner {
  const secret = config.get('STORAGE_SIGNING_SECRET');
  if (secret) return new UrlSigner(secret);
  // Production refuses to start without a secret (see env.ts). Elsewhere a per-process
  // secret is fine: links simply stop working after a restart.
  new Logger('StorageModule').warn(
    'STORAGE_SIGNING_SECRET is not set; using a temporary secret for storage links',
  );
  return new UrlSigner(randomBytes(32).toString('hex'));
}

/** The configured object store (local disk or S3-compatible), shared app-wide. */
@Global()
@Module({
  providers: [
    { provide: UrlSigner, inject: [AppConfig], useFactory: signerFor },
    {
      provide: StorageDriver,
      inject: [AppConfig, UrlSigner],
      useFactory: (config: AppConfig, signer: UrlSigner): StorageDriver => {
        const api = config.get('API_PUBLIC_URL').replace(/\/+$/, '');
        if (config.get('STORAGE_DRIVER') === 's3') {
          return new S3StorageDriver({
            endpoint: config.get('S3_ENDPOINT'),
            region: config.get('S3_REGION'),
            bucket: config.get('S3_BUCKET')!,
            accessKeyId: config.get('S3_ACCESS_KEY_ID')!,
            secretAccessKey: config.get('S3_SECRET_ACCESS_KEY')!,
            forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
            publicBaseUrl: config.get('S3_PUBLIC_BASE_URL'),
            apiPublicUrl: api,
          });
        }
        return new LocalStorageDriver(config.get('STORAGE_LOCAL_DIR'), api, signer);
      },
    },
  ],
  exports: [StorageDriver, UrlSigner],
})
export class StorageModule {}
