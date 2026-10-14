// Starts the API and the four web apps together. Ctrl+C stops everything.
import { spawn } from 'node:child_process';

const procs = [
  { name: 'api', filter: '@churchos/api', script: 'start', color: '\x1b[36m' },
  { name: 'giving', filter: '@churchos/giving', script: 'dev', color: '\x1b[32m' },
  { name: 'member', filter: '@churchos/member', script: 'dev', color: '\x1b[33m' },
  { name: 'staff', filter: '@churchos/staff', script: 'dev', color: '\x1b[35m' },
  { name: 'admin', filter: '@churchos/admin', script: 'dev', color: '\x1b[34m' },
];

const children = procs.map((p) => {
  const child = spawn('pnpm', ['--filter', p.filter, p.script], { shell: true, env: { ...process.env, FORCE_COLOR: '0' } });
  const tag = `${p.color}[${p.name}]\x1b[0m`;
  const pipe = (stream) =>
    stream.on('data', (d) =>
      String(d)
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l) => console.log(`${tag} ${l}`)),
    );
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => console.log(`${tag} exited with code ${code}`));
  return child;
});

const stop = () => {
  for (const c of children) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { shell: true });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

setTimeout(() => {
  console.log('\n  ChurchOS is starting. Open these once the apps report "ready":');
  console.log('    Giving page      http://localhost:3001   (try /GRC001)');
  console.log('    Member app       http://localhost:3002');
  console.log('    Staff dashboard  http://localhost:3003');
  console.log('    Platform admin   http://localhost:3004');
  console.log('    API              http://localhost:4000/health\n');
}, 4000);
