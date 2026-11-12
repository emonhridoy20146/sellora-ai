'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { LandingPage, MyLandingTemplate } from '@/lib/api/types';
import { landingKeys } from './hooks';

/**
 * Saves the page's last saved draft as one of the business's own templates (ADR 0031):
 * sections, packages and settings, without the product, add-on or search settings.
 */
export function SaveTemplateDialog({
  orgId,
  page,
  open,
  onOpenChange,
}: {
  orgId: string;
  page: LandingPage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = async () => {
    if (name.trim().length < 2) return setErrors({ name: 'Name the template' });
    setBusy(true);
    setErrors({});
    try {
      await api<MyLandingTemplate>(`/orgs/${orgId}/landing-pages/${page.id}/save-template`, {
        body: {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      });
      await queryClient.invalidateQueries({ queryKey: landingKeys.templates(orgId) });
      toast.success('Saved. Choose it under “My templates” when you make a new page.');
      setName('');
      setDescription('');
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) setErrors(err.fieldErrors());
      else setErrors({ form: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Save as template"
        description="New pages can start from this page’s sections, packages and settings. The product and add-on are left out. Unsaved changes in the editor are not included."
      >
        <Field label="Template name" htmlFor="tpl-name" error={errors.name}>
          <Input
            id="tpl-name"
            value={name}
            maxLength={60}
            placeholder={page.name.slice(0, 60)}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Note" htmlFor="tpl-desc" optional error={errors.description}>
          <Textarea
            id="tpl-desc"
            rows={2}
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {errors.form && (
          <p role="alert" className="text-sm text-destructive">
            {errors.form}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
