import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CouponsController } from './coupons.controller.js';
import { CouponsService } from './coupons.service.js';
import { CouponRepository, CouponUseRepository } from './repositories.js';
import { couponSchema, couponUseSchema } from './schemas.js';

/**
 * Coupons without HTTP routes (ADR 0031): orders take and give back uses inside their own
 * transactions, and the storefront checks codes for shoppers.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Coupon', schema: couponSchema },
      { name: 'CouponUse', schema: couponUseSchema },
    ]),
  ],
  providers: [CouponRepository, CouponUseRepository, CouponsService],
  exports: [CouponsService],
})
export class CouponsCoreModule {}

/** Coupons (the dashboard's Coupons page). */
@Module({
  imports: [CouponsCoreModule],
  controllers: [CouponsController],
})
export class CouponsModule {}
