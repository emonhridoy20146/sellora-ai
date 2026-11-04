'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { commerceKeys } from '@/components/commerce/hooks';
import { ProductForm } from '@/components/commerce/product-form';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';

export default function NewProductPage() {
  const { org } = useOrg();
  const router = useRouter();
  const queryClient = useQueryClient();
  return (
    <div className="mx-auto w-full max-w-4xl">
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href={`/app/${org.id}/products`}>
          <ArrowLeft /> Products
        </Link>
      </Button>
      <PageHeader title="Add product" />
      <ProductForm
        onSaved={(p) => {
          void queryClient.invalidateQueries({ queryKey: commerceKeys.all(org.id) });
          toast.success(`${p.name} added.`);
          router.push(`/app/${org.id}/products/${p.id}`);
        }}
      />
    </div>
  );
}
