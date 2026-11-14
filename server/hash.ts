/** Print a passphrase record for MCL_OWNER_PASSPHRASE_RECORD. Reads the passphrase from stdin. */
import { hashPassphrase } from './crypto.ts';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const pass = input.trim();
if (pass.length < 12) {
  console.error('Use a passphrase of at least 12 characters.');
  process.exit(1);
}
console.log(await hashPassphrase(pass));
