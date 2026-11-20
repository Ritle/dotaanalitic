import { createHash } from 'node:crypto';

// These exact CRLF byte sequences were applied on the previous Windows host.
// Keep the original ledger; accept no other migration, SQL edit or checksum.
const historical = {
  '053_owner_lineup_templates.sql': {
    lf: '1fd0068044746b20ad96bf749a07ce1b524628c1d26c964ca69ea3c0598275f6',
    crlf: 'c0ea830053e810e60ff3dc41119081a253f43fb2880f877d03bb50b147598c21',
  },
  '054_upcoming_forecast_preparations.sql': {
    lf: 'a71ee5ee446108ea0375ec36f66ac02785dd88d340ecc37fd54a3c8fb34f6396',
    crlf: 'fe41c2576bec37b6671de8c865a0e52cc44e69cea4f7a2859bccf2e37a7087bf',
  },
};
const sha = text => createHash('sha256').update(text).digest('hex');

export function isHistoricalCrlfChecksum(filename, sql, ledgerChecksum) {
  const entry = Object.hasOwn(historical, filename) ? historical[filename] : null;
  return !!entry && ledgerChecksum === entry.crlf && sha(sql) === entry.lf &&
    sha(sql.replaceAll('\n', '\r\n')) === entry.crlf;
}
