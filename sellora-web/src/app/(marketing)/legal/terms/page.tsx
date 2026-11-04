import type { Metadata } from 'next';
import { site } from '@/config/site';
import { LegalPage } from '../legal-page';

export const metadata: Metadata = { title: 'Terms of service' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="27 October 2026">
      <p>
        These terms are an agreement between you (the business using {site.name}) and the operator
        of {site.name}. By creating an account you accept them on behalf of your business.
      </p>
      <h2>1. Your account</h2>
      <ul>
        <li>You must give accurate details and keep your password and two-step codes private.</li>
        <li>You are responsible for what your staff do with the access you give them.</li>
        <li>You must be allowed to run your business and to sell the products you list.</li>
      </ul>
      <h2>2. Plans and payment</h2>
      <ul>
        <li>
          Plans renew at the end of each period until you cancel. Prices are shown before you pay.
        </li>
        <li>
          If a renewal payment fails, paid features continue for a short grace period, then stop
          until you pay.
        </li>
        <li>Taxes, where they apply, are shown on your invoice.</li>
      </ul>
      <h2>3. Wallet and AI credits</h2>
      <ul>
        <li>
          Money you add to your wallet is used to pay for AI credits and, if you choose, your plan.
        </li>
        <li>
          Each AI action uses credits at the price shown in your billing page when the action
          happens.
        </li>
        <li>
          Free credits (from a plan or a promotion) can only be used for AI and cannot be withdrawn.
        </li>
        <li>
          Withdrawals of unused wallet money, if offered, need our approval and may take several
          working days.
        </li>
      </ul>
      <h2>4. Acceptable use</h2>
      <p>
        You may not use {site.name} to send spam, to deceive customers, to sell illegal goods, or to
        break the rules of Facebook, Instagram, WhatsApp or any other connected platform.
      </p>
      <h2>5. AI replies</h2>
      <p>
        AI replies are generated automatically and can be wrong. You control when the AI may answer
        on its own, and you remain responsible for prices, stock and promises made to your
        customers.
      </p>
      <h2>6. Suspension and closing</h2>
      <p>
        We may suspend an account that breaks these terms or puts other users at risk. You can close
        your account at any time and download your data first.
      </p>
      <h2>7. Liability</h2>
      <p>
        To the extent the law allows, our total liability is limited to the amount you paid us in
        the three months before the claim.
      </p>
      <h2>8. Changes</h2>
      <p>We will tell you by email before material changes to these terms take effect.</p>
      <h2>9. Contact</h2>
      <p>Questions about these terms: {site.supportEmail}</p>
    </LegalPage>
  );
}
