'use client';

import { Input } from '@/components/ui/input';

/** Six-digit authenticator code. Lets the phone keyboard and password managers fill it. */
export function CodeInput(props: React.ComponentProps<'input'>) {
  return (
    <Input
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="123456"
      className="text-center font-mono text-lg tracking-[0.4em]"
      {...props}
    />
  );
}
