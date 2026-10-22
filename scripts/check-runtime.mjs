// Import checks only. Do not create a WhatsApp socket or read/write credentials.
try {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 24) {
    throw new Error('Node.js 24 or later is required.');
  }
  const [baileys, qr, logging] = await Promise.all([
    import('@whiskeysockets/baileys'),
    import('qrcode-terminal'),
    import('pino'),
  ]);
  if (typeof baileys.default !== 'function'
    || typeof baileys.useMultiFileAuthState !== 'function'
    || typeof baileys.DisconnectReason !== 'object'
    || typeof qr.default?.generate !== 'function'
    || typeof logging.default !== 'function') {
    throw new Error('A required Baileys, QR, or logging dependency has an incompatible API.');
  }
  console.log(`Runtime check passed. Node.js ${major} and Baileys dependencies loaded. No WhatsApp connection or credential access was made.`);
} catch (error) {
  const detail = String(error?.message || 'Unknown runtime error').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
  console.error(`Runtime check failed: ${detail}`);
  console.error('Use Node.js 24 or later and install the project dependencies from package-lock.json.');
  process.exitCode = 1;
}
