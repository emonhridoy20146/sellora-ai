import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EncryptionService } from '../../../common/crypto/encryption.service.js';
import { OneTimeTokenService } from './one-time-token.service.js';
import { oneTimeTokenSchema } from './one-time-token.schema.js';
import { PasswordService } from './password.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { sessionSchema } from './session.schema.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { TotpService } from './totp.service.js';

/** Realm-independent building blocks shared by merchant and platform authentication. */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Session', schema: sessionSchema },
      { name: 'OneTimeToken', schema: oneTimeTokenSchema },
    ]),
  ],
  providers: [
    TokenService,
    PasswordService,
    TotpService,
    SessionService,
    OneTimeTokenService,
    RateLimitService,
    EncryptionService,
  ],
  exports: [
    TokenService,
    PasswordService,
    TotpService,
    SessionService,
    OneTimeTokenService,
    RateLimitService,
    EncryptionService,
  ],
})
export class AuthCoreModule {}
