import type { PlanLimits } from './api/types';

/**
 * The plan module a limit belongs to. A limit is only worth showing when the plan has that
 * module: "unlimited products" means nothing on a plan without orders and products.
 */
const LIMIT_MODULE: Partial<Record<keyof PlanLimits, string>> = {
  products: 'commerce',
  ordersPerMonth: 'commerce',
  storageMb: 'commerce',
  websitePages: 'commerce',
  stores: 'storefront',
  customDomains: 'storefront',
  landingPages: 'landing_pages',
  channels: 'inbox',
  conversationsPerMonth: 'inbox',
};

export function limitApplies(modules: { key: string }[], limit: keyof PlanLimits): boolean {
  const needs = LIMIT_MODULE[limit];
  return !needs || modules.some((m) => m.key === needs);
}
