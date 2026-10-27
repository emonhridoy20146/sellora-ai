import type { Metadata } from 'next';
import { site } from '@/config/site';
import { LegalPage } from '../legal-page';

export const metadata: Metadata = { title: 'Privacy policy' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="27 October 2026">
      <p>This policy explains what {site.name} collects, why, and the choices you have.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Account details: your name, email, phone number and business details.</li>
        <li>
          Security records: sign-in times, IP addresses and the actions recorded in your audit log.
        </li>
        <li>Business data you add or connect: products, orders, customers and conversations.</li>
        <li>
          Billing records: plans, wallet top-ups, AI usage and invoices. Card details are handled by
          the payment gateway, not stored by us.
        </li>
      </ul>
      <h2>How we use it</h2>
      <ul>
        <li>To run the service you signed up for, including AI replies when you turn them on.</li>
        <li>To keep accounts secure and to investigate abuse.</li>
        <li>To bill you correctly and meet legal and tax duties.</li>
      </ul>
      <h2>AI processing</h2>
      <p>
        When AI features are on, the text needed to answer a message (for example the conversation
        and relevant product details) is sent to an AI provider to generate the reply. We do not let
        providers use your data to train their models where the provider offers that choice.
      </p>
      <h2>Your customers&apos; data</h2>
      <p>
        For your customers&apos; data you are the controller and we process it on your behalf. Each
        business&apos;s data is kept separate from every other business.
      </p>
      <h2>Sharing</h2>
      <p>
        We share data only with providers that help run the service (hosting, email, payments, AI,
        couriers you choose), or when the law requires it. We never sell personal data.
      </p>
      <h2>Keeping and deleting data</h2>
      <p>
        We keep data while your account is open. After you close it, we delete or anonymise it
        within a set period, except records the law requires us to keep.
      </p>
      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your data, ask us to correct it, or ask us to delete it. Write to{' '}
        {site.supportEmail}.
      </p>
    </LegalPage>
  );
}
