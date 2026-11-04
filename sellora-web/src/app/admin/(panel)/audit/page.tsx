'use client';

import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { AuditList } from '@/components/audit-list';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { AuditChainCheck } from '@/lib/api/types';
import { formatNumber } from '@/lib/format';

const REASONS: Record<NonNullable<AuditChainCheck['reason']>, string> = {
  missing_event: 'an entry is missing',
  prev_hash_mismatch: 'an entry does not link to the one before it',
  hash_mismatch: 'an entry was changed after it was written',
  head_mismatch: 'the newest entries were removed',
};

export default function PlatformAuditPage() {
  const [scope, setScope] = useState<'all' | 'platform'>('all');
  const [orgInput, setOrgInput] = useState('');
  const orgId = useDebounced(orgInput.trim());
  const orgValid = /^[a-f0-9]{24}$/i.test(orgId);
  const chainScope = scope === 'platform' ? 'platform' : orgValid ? orgId : 'platform';
  const verify = useMutation({
    meta: { silent: true },
    mutationFn: (s: string) => api<AuditChainCheck>(`/platform/audit-events/verify/${s}`),
  });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, setting, money movement and admin action, chained with hashes so edits are detectable."
        actions={
          <Button
            variant="outline"
            loading={verify.isPending}
            onClick={() => verify.mutate(chainScope)}
          >
            <ShieldCheck /> Check {chainScope === 'platform' ? 'platform' : 'business'} log
          </Button>
        }
      />
      {verify.data &&
        (verify.data.ok ? (
          <Alert tone="success" className="mb-4" title="The log is intact">
            {formatNumber(verify.data.checked)} entries checked; none were changed or removed.
          </Alert>
        ) : (
          <Alert
            tone="danger"
            className="mb-4"
            title={`The log is broken at entry ${verify.data.brokenAt}`}
          >
            {verify.data.reason ? `Cause: ${REASONS[verify.data.reason]}.` : null} Treat this as a
            security incident.
          </Alert>
        ))}
      {verify.error && (
        <Alert tone="danger" className="mb-4">
          {errorMessage(verify.error)}
        </Alert>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
          <Segmented
            label="Which events"
            value={scope}
            onChange={(v) => {
              setScope(v);
              verify.reset();
            }}
            options={[
              { value: 'all', label: 'Everything' },
              { value: 'platform', label: 'Platform team only' },
            ]}
          />
          {scope === 'all' && (
            <>
              <label htmlFor="audit-org" className="sr-only">
                Business ID
              </label>
              <Input
                id="audit-org"
                className="h-8 max-w-64 font-mono text-xs"
                placeholder="Business ID (optional)"
                value={orgInput}
                aria-invalid={orgInput.trim() !== '' && !/^[a-f0-9]{24}$/i.test(orgInput.trim())}
                onChange={(e) => {
                  setOrgInput(e.target.value);
                  verify.reset();
                }}
              />
            </>
          )}
        </div>
        <AuditList
          path="/platform/audit-events"
          queryKey={['platform', 'audit']}
          showOrg={scope === 'all' && !orgValid}
          filters={{
            scope: scope === 'platform' ? 'platform' : undefined,
            orgId: scope === 'all' && orgValid ? orgId : undefined,
          }}
        />
      </Card>
    </>
  );
}
