import { spawn } from 'node:child_process';

const script = process.platform === 'win32' ? 'dist:win' : process.platform === 'linux' ? 'dist:linux' : null;
if (!script || !process.env.npm_execpath) {
  throw Error('Run npm run dist on Windows or Linux. Use Linux for AppImage creation.');
}
const args = [process.env.npm_execpath, 'run', script];
if (process.argv.length > 2) args.push('--', ...process.argv.slice(2));
const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
