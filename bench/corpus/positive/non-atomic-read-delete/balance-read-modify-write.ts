// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: non-atomic-read-delete
// The balance is read, then written back minus the debit — with no
// guard against a concurrent debit landing between the read and the
// write, two simultaneous withdrawals can both succeed from a balance
// that only covers one.

import { ledger } from "../fixtures/ledger.js";

export async function debitAccount(accountId: string, amount: number): Promise<void> {
  const balance = await ledger.get(accountId);
  await ledger.set(accountId, balance - amount);
}
