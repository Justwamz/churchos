import { SecurityPanel } from '@churchos/ui';
import { PageHeader } from '../ui';
import { api, type PageProps } from '../common';

/** Passkeys and signed-in devices for this admin account. */
export function Security({ toast }: PageProps) {
  return (
    <>
      <PageHeader title="Security" subtitle="Passkeys and the devices where you are signed in." />
      <SecurityPanel api={api} toast={toast} />
    </>
  );
}
