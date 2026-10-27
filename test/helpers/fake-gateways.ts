import type { GatewayFetch } from '../../src/modules/billing/payments/gateway.types.js';

interface SslValidation {
  status: 'VALID' | 'VALIDATED' | 'INVALID_TRANSACTION';
  tran_id: string;
  amount: string;
  currency: string;
  bank_tran_id?: string;
}

/**
 * Plays SSLCommerz, bKash and Stripe for end-to-end tests. It answers the same endpoints
 * with the same response shapes as the real sandboxes, and records what it was asked.
 * This proves our side of the contract; it does not prove the real gateways behave so.
 */
export class FakeGateways {
  readonly calls: { url: string; body: string }[] = [];
  /** tran_id -> amount the checkout was opened for */
  readonly sslSessions = new Map<string, { amount: string; currency: string }>();
  readonly sslValidations = new Map<string, SslValidation>();
  /** paymentID -> invoice + amount */
  readonly bkashPayments = new Map<
    string,
    { invoice: string; amount: string; completed: boolean }
  >();
  readonly stripeSessions = new Map<string, { ref: string; amount: number; currency: string }>();
  failNextCheckout = false;

  readonly fetch: GatewayFetch = (input, init) => Promise.resolve(this.handle(input, init));

  private handle(input: Parameters<GatewayFetch>[0], init: Parameters<GatewayFetch>[1]): Response {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    this.calls.push({ url, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (
      this.failNextCheckout &&
      !url.includes('validator') &&
      !url.includes('execute') &&
      !url.includes('grant')
    ) {
      this.failNextCheckout = false;
      return json(500, { status: 'FAILED', failedreason: 'maintenance' });
    }

    if (url.endsWith('/gwprocess/v4/api.php')) {
      const form = new URLSearchParams(body);
      const tran = form.get('tran_id')!;
      this.sslSessions.set(tran, {
        amount: form.get('total_amount')!,
        currency: form.get('currency')!,
      });
      return json(200, {
        status: 'SUCCESS',
        sessionkey: `SK${tran}`,
        GatewayPageURL: `https://sandbox.sslcommerz.com/EasyCheckOut/${tran}`,
      });
    }
    if (url.includes('/validator/api/validationserverAPI.php')) {
      const valId = new URL(url).searchParams.get('val_id')!;
      const v = this.sslValidations.get(valId);
      if (!v) return json(200, { status: 'INVALID_TRANSACTION' });
      return json(200, {
        ...v,
        val_id: valId,
        currency_type: v.currency,
        currency_amount: v.amount,
      });
    }
    if (url.endsWith('/tokenized/checkout/token/grant')) {
      return json(200, {
        statusCode: '0000',
        id_token: 'bk-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (url.endsWith('/tokenized/checkout/create')) {
      const req = JSON.parse(body) as { amount: string; merchantInvoiceNumber: string };
      const paymentID = `BK${req.merchantInvoiceNumber}`;
      this.bkashPayments.set(paymentID, {
        invoice: req.merchantInvoiceNumber,
        amount: req.amount,
        completed: false,
      });
      return json(200, {
        statusCode: '0000',
        statusMessage: 'Successful',
        paymentID,
        bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${paymentID}`,
      });
    }
    if (
      url.endsWith('/tokenized/checkout/execute') ||
      url.endsWith('/tokenized/checkout/payment/status')
    ) {
      const { paymentID } = JSON.parse(body) as { paymentID: string };
      const p = this.bkashPayments.get(paymentID);
      if (!p) return json(200, { statusCode: '2056', statusMessage: 'Invalid Payment State' });
      p.completed = true;
      return json(200, {
        statusCode: '0000',
        paymentID,
        trxID: `TRX${paymentID.slice(-6)}`,
        transactionStatus: 'Completed',
        amount: p.amount,
        currency: 'BDT',
        merchantInvoiceNumber: p.invoice,
      });
    }
    if (url.endsWith('/v1/checkout/sessions')) {
      const form = new URLSearchParams(body);
      const ref = form.get('client_reference_id')!;
      const id = `cs_test_${ref}`;
      this.stripeSessions.set(id, {
        ref,
        amount: Number(form.get('line_items[0][price_data][unit_amount]')),
        currency: form.get('line_items[0][price_data][currency]')!,
      });
      return json(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    return json(404, { error: 'unknown endpoint in fake gateway' });
  }
}
