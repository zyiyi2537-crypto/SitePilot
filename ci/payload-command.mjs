import { spawn } from 'node:child_process';

// Bounded diagnostics accessible via check annotations, without uploading credentials.
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Command is required');
const secrets = [process.env.SITEPILOT_CI_PASSWORD, process.env.PREVIEW_SECRET, process.env.PAYLOAD_SECRET].filter(Boolean);
let output = '';
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
function capture(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  output = (output + text).slice(-24000);
}
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.on('error', error => capture(Buffer.from(error.message)));
child.on('close', code => {
  if (code !== 0) {
    let excerpt = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-70).join('\n');
    for (const secret of secrets) excerpt = excerpt.replaceAll(secret, '[redacted]');
    excerpt = excerpt.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::error title=Payload CMS preview acceptance::${excerpt}`);
  }
  process.exitCode = code ?? 1;
});
