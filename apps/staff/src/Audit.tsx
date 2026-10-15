import { AuditLog } from '@churchos/ui';
import { api, useSession } from './session';
import { PageHead } from './bits';

export function AuditPage() {
  const session = useSession();
  return (
    <>
      <PageHead title="Audit log" sub="Everything that changes in your church is recorded here with who did it, when, and what changed. Entries cannot be edited or deleted." />
      <AuditLog api={api} base="/audit" qs={session.orgs.length > 1 ? `&org=${session.grant.org.id}` : ''} canExport={session.can('audit.export')} />
      <p className="tiny" style={{ marginTop: 16 }}><b>Privacy.</b> Sensitive details such as phone numbers and dates of birth are hidden in the log. Showing one is itself recorded.</p>
    </>
  );
}
