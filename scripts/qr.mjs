/**
 * Prints a scannable QR code for a URL.
 *
 *   npm run qr -- https://example.github.io/GIF_Maker/
 *
 * The dev server prints its own QR automatically (see the qrCode plugin in
 * vite.config.ts), so this is for URLs Vite does not know about — chiefly the
 * deployed site. Dev-only: nothing here ships in the built app.
 */
import qrcode from 'qrcode-terminal';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npm run qr -- <url>');
  console.error('The dev server already prints a QR for the local address.');
  process.exit(1);
}

console.log('');
qrcode.generate(url, { small: true });
console.log(`  ${url}\n`);
