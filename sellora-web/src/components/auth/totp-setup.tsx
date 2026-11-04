'use client';

import { Download } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Field } from '@/components/ui/field';
import { CodeInput } from './code-input';

/** QR code plus the secret typed out, for authenticator apps (Google Authenticator, Authy…). */
export function TotpQr({ otpauthUrl, secret }: { otpauthUrl: string; secret: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void QRCode.toString(otpauthUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (s) => alive && setSvg(s),
    );
    return () => {
      alive = false;
    };
  }, [otpauthUrl]);
  return (
    <div className="grid gap-3 sm:grid-cols-[160px_1fr] sm:items-center">
      <div
        className="mx-auto size-40 rounded-lg border bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
        role="img"
        aria-label="QR code for your authenticator app"
        // The SVG is generated locally from our own otpauth URL, not from user input.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <div className="grid gap-2 text-sm">
        <p>Scan this with your authenticator app. Or type this key:</p>
        <p className="rounded-md bg-muted px-2 py-1.5 font-mono text-[13px] break-all">
          {secret.match(/.{1,4}/g)?.join(' ')}
        </p>
        <div>
          <CopyButton value={secret} label="Copy key" />
        </div>
      </div>
    </div>
  );
}

export function TotpCodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Code from the app" htmlFor="totp-code">
      <CodeInput
        id="totp-code"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      />
    </Field>
  );
}

export function RecoveryCodes({ codes, account }: { codes: string[]; account: string }) {
  const text = `Recovery codes for ${account}\nEach code works once.\n\n${codes.join('\n')}\n`;
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Save these recovery codes somewhere safe. Each one lets you sign in once if you lose your
        phone. They will not be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-1.5 rounded-lg border bg-muted/50 p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <CopyButton value={codes.join('\n')} label="Copy codes" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'recovery-codes.txt';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download /> Download
        </Button>
      </div>
    </div>
  );
}
