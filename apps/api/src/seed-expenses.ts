import { INTERNAL_SEED_KEY } from './ctx';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './ctx';
import { gradientPng } from './artwork';

/**
 * Expense demo data (L235 to L244) for the development server: Volunteer Vera, who can claim from the member app, a few recorded and
 * approved expenses, two waiting for approval, a claim to pay, and a yearly budget and a project budget.
 */
export async function seedExpensesDemo(app: FastifyInstance, ctx: Ctx) {
  const db = ctx.db;
  const now = ctx.clock.now().toISOString();
  await db.query(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ('u_vera','254700000010','Volunteer Vera',false,$1) ON CONFLICT DO NOTHING`, [now]);
  await db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_vera','org_grace','u_vera','org_grace:Volunteer','branch','br_grc001') ON CONFLICT DO NOTHING`);

  const token = async (phone: string) => (await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } })).json().token as string;
  const [esther, samuel, daniel, vera] = [await token('0700000002'), await token('0700000003'), await token('0700000001'), await token('0700000010')];
  const call = (tok: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${tok}`, 'x-churchos-internal-seed': INTERNAL_SEED_KEY } });
  const setup = (await call(esther, 'GET', '/expenses/setup')).json();
  const cat = (name: string) => setup.categories.find((c: any) => c.name === name).id as string;
  const day = (ago: number) => new Date(ctx.clock.now().getTime() + 3 * 3600_000 - ago * 86_400_000).toISOString().slice(0, 10);
  const receipt = (n: number) => ({ name: `receipt-${n}.png`, mime: 'image/png', data: gradientPng(160, 220, [235, 235, 225], [60, 60, 70]) });

  const rec = (extra: Record<string, unknown>) => call(esther, 'POST', '/expenses', { branchId: 'br_grc001', method: 'mpesa', ...extra });
  await rec({ date: day(9), amount: 4200, categoryId: cat('Utilities'), payee: 'Kenya Power', reference: 'RK31PL9T', note: 'Electricity for September', files: [receipt(0)] });
  await rec({ date: day(6), amount: 1800, categoryId: cat('Supplies'), payee: 'Mama Njeri Stores', reference: 'RK35QW2A', note: 'Cleaning supplies for the hall', files: [receipt(1)] });
  await rec({ date: day(4), amount: 3500, categoryId: cat('Transport'), payee: 'City Hoppa', method: 'cash', note: 'Bus hire for the youth outing', noReceiptReason: 'The driver did not give a receipt' });
  const repairs = await rec({ date: day(3), amount: 28000, categoryId: cat('Repairs and maintenance'), payee: 'Mwangi Builders', reference: 'RK39ZX4B', note: 'Repairing the hall roof leak', files: [receipt(2), receipt(3)] });
  await rec({ date: day(1), amount: 6500, categoryId: cat('Salaries and allowances'), payee: 'Sound engineer', method: 'cash', note: 'Allowance for the Sunday sound engineer', noReceiptReason: 'Signed acknowledgement kept in the office' });
  const approved = (await call(esther, 'GET', '/expenses?status=submitted')).json().expenses.find((e: any) => e.payee === 'Sound engineer');
  if (approved) await call(samuel, 'POST', `/expenses/${approved.id}/decide`, { approve: true, note: 'Checked the signed note' });
  void repairs;

  const claim = (extra: Record<string, unknown>) => call(vera, 'POST', '/me/claims', { branchId: 'br_grc001', method: 'other', ...extra });
  await claim({ date: day(2), amount: 650, categoryId: cat('Transport'), payee: 'Bus fare to the printers', note: 'Collected the Easter programmes' });
  const printing = await claim({ date: day(5), amount: 2400, categoryId: cat('Printing and communication'), payee: 'Printing of the Easter programmes', note: 'Paid at the print shop', files: [receipt(4)] });
  if (printing.statusCode === 200) await call(samuel, 'POST', `/expenses/${printing.json().id}/decide`, { approve: true });

  const year = Number(day(0).slice(0, 4));
  await call(esther, 'PUT', '/expenses/budgets', { branchId: 'br_grc001', year, categories: [{ categoryId: cat('Utilities'), amount: 60000 }, { categoryId: cat('Repairs and maintenance'), amount: 80000 }, { categoryId: cat('Supplies'), amount: 25000 }] });
  const roof = setup.projects.find((p: any) => p.code === 'ROOF');
  if (roof) await call(esther, 'PUT', '/expenses/project-budget', { projectId: roof.id, amount: 3000000 });
  void daniel;
}
