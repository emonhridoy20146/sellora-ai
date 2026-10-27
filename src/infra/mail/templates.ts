export type Locale = 'en' | 'bn';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function layout(
  title: string,
  paragraphs: string[],
  action?: { label: string; url: string },
): string {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px;line-height:1.6">${escapeHtml(p)}</p>`)
    .join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p><p style="font-size:12px;color:#6b7280;word-break:break-all">${escapeHtml(action.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans Bengali',sans-serif;color:#18181b"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:32px"><tr><td><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}${button}<p style="font-size:12px;color:#6b7280;margin-top:32px">Sellora AI</p></td></tr></table></td></tr></table></body></html>`;
}

function render(
  title: string,
  paragraphs: string[],
  action?: { label: string; url: string },
): RenderedMail {
  const text = [...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : [])].join('\n\n');
  return { subject: title, text, html: layout(title, paragraphs, action) };
}

export const mailTemplates = {
  verifyEmail(locale: Locale, p: { name: string; url: string }): RenderedMail {
    return locale === 'bn'
      ? render(
          'আপনার ইমেইল যাচাই করুন',
          [
            `হ্যালো ${p.name},`,
            'Sellora AI অ্যাকাউন্ট চালু করতে নিচের বোতামে ক্লিক করুন। লিংকটি ২৪ ঘণ্টা কার্যকর থাকবে।',
          ],
          { label: 'ইমেইল যাচাই করুন', url: p.url },
        )
      : render(
          'Verify your email',
          [
            `Hi ${p.name},`,
            'Confirm your email to activate your Sellora AI account. This link expires in 24 hours.',
          ],
          { label: 'Verify email', url: p.url },
        );
  },

  signupAttemptExistingAccount(
    locale: Locale,
    p: { name: string; loginUrl: string; resetUrl: string },
  ): RenderedMail {
    return locale === 'bn'
      ? render(
          'আপনার ইমেইল দিয়ে আবার সাইন আপ করার চেষ্টা হয়েছে',
          [
            `হ্যালো ${p.name},`,
            'এই ইমেইল দিয়ে আগে থেকেই একটি অ্যাকাউন্ট আছে। আপনি না করে থাকলে এই ইমেইল উপেক্ষা করুন।',
            `পাসওয়ার্ড ভুলে গেলে: ${p.resetUrl}`,
          ],
          { label: 'লগ ইন করুন', url: p.loginUrl },
        )
      : render(
          'Someone tried to sign up with your email',
          [
            `Hi ${p.name},`,
            'An account with this email already exists. If this was not you, you can ignore this message.',
            `Forgot your password? ${p.resetUrl}`,
          ],
          { label: 'Log in', url: p.loginUrl },
        );
  },

  passwordReset(locale: Locale, p: { name: string; url: string }): RenderedMail {
    return locale === 'bn'
      ? render(
          'পাসওয়ার্ড রিসেট করুন',
          [
            `হ্যালো ${p.name},`,
            'পাসওয়ার্ড রিসেট করতে নিচের বোতামে ক্লিক করুন। লিংকটি ৩০ মিনিট কার্যকর থাকবে। আপনি অনুরোধ না করলে এই ইমেইল উপেক্ষা করুন।',
          ],
          { label: 'পাসওয়ার্ড রিসেট', url: p.url },
        )
      : render(
          'Reset your password',
          [
            `Hi ${p.name},`,
            'Use the button below to choose a new password. The link expires in 30 minutes. If you did not ask for this, ignore this email.',
          ],
          { label: 'Reset password', url: p.url },
        );
  },

  passwordChanged(locale: Locale, p: { name: string }): RenderedMail {
    return locale === 'bn'
      ? render('আপনার পাসওয়ার্ড পরিবর্তন হয়েছে', [
          `হ্যালো ${p.name},`,
          'আপনার অ্যাকাউন্টের পাসওয়ার্ড পরিবর্তন করা হয়েছে এবং অন্য সব ডিভাইস থেকে লগ আউট করা হয়েছে। আপনি না করে থাকলে এখনই সাপোর্টে যোগাযোগ করুন।',
        ])
      : render('Your password was changed', [
          `Hi ${p.name},`,
          'Your password was changed and every other device was signed out. If this was not you, contact support immediately.',
        ]);
  },

  invitation(
    locale: Locale,
    p: { orgName: string; inviterName: string; roleName: string; url: string },
  ): RenderedMail {
    return locale === 'bn'
      ? render(
          `${p.orgName} এ যোগ দেওয়ার আমন্ত্রণ`,
          [
            `${p.inviterName} আপনাকে ${p.orgName} এ ${p.roleName} হিসেবে যোগ দিতে আমন্ত্রণ জানিয়েছেন। আমন্ত্রণটি ৭ দিন কার্যকর থাকবে।`,
          ],
          { label: 'আমন্ত্রণ গ্রহণ করুন', url: p.url },
        )
      : render(
          `Join ${p.orgName} on Sellora AI`,
          [
            `${p.inviterName} invited you to join ${p.orgName} as ${p.roleName}. The invitation expires in 7 days.`,
          ],
          { label: 'Accept invitation', url: p.url },
        );
  },

  mfaChanged(locale: Locale, p: { name: string; enabled: boolean }): RenderedMail {
    const en = p.enabled
      ? 'Two-factor authentication was turned on for your account.'
      : 'Two-factor authentication was turned off for your account. If this was not you, reset your password now.';
    const bn = p.enabled
      ? 'আপনার অ্যাকাউন্টে টু-ফ্যাক্টর অথেন্টিকেশন চালু হয়েছে।'
      : 'আপনার অ্যাকাউন্টে টু-ফ্যাক্টর অথেন্টিকেশন বন্ধ করা হয়েছে। আপনি না করে থাকলে এখনই পাসওয়ার্ড রিসেট করুন।';
    return locale === 'bn'
      ? render('নিরাপত্তা সতর্কতা', [`হ্যালো ${p.name},`, bn])
      : render('Security alert', [`Hi ${p.name},`, en]);
  },

  platformInvite(p: { name: string; url: string; role: string }): RenderedMail {
    return render(
      'Your Sellora platform admin account',
      [
        `Hi ${p.name},`,
        `You were added as a platform ${p.role}. Set your password and two-factor authentication within 24 hours.`,
      ],
      { label: 'Set up account', url: p.url },
    );
  },

  newDeviceLogin(
    locale: Locale,
    p: { name: string; ip: string; userAgent: string; when: string },
  ): RenderedMail {
    return locale === 'bn'
      ? render('নতুন ডিভাইস থেকে লগ ইন', [
          `হ্যালো ${p.name},`,
          `${p.when} সময়ে ${p.ip} থেকে লগ ইন হয়েছে (${p.userAgent})। আপনি না করে থাকলে পাসওয়ার্ড পরিবর্তন করুন।`,
        ])
      : render('New sign-in to your account', [
          `Hi ${p.name},`,
          `We noticed a sign-in at ${p.when} from ${p.ip} (${p.userAgent}). If this was not you, change your password.`,
        ]);
  },
};
