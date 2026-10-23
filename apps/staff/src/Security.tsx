import { SecurityPanel, useToast } from '@churchos/ui';
import { api } from './session';
import { PageHeader } from './ui';

/** Your own sign-in security: passkeys and the devices you are signed in on. Opened from the account menu (your picture or initials). */
export function Security() {
  const toast = useToast();
  return (
    <div>
      <PageHeader title="Security" subtitle="Sign in with your fingerprint or face, and see where you are signed in." />
      <div className="stack">
        <SecurityPanel api={api} toast={toast.show} />
      </div>
      {toast.node}
    </div>
  );
}
