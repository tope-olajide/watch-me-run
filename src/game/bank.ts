/**
 * The tokens that outlive the run they were collected in.
 *
 * Every run already had a score and a best, and both of them are *about* the run: they say how well it
 * went. Tokens were the one currency the game paid out that did nothing once the card was up — they
 * paid points and stopped. Banking them is what turns a run into a *purchase*, and it is the reason to
 * take a deal that pays more tokens at the cost of surviving fewer hits: Glass cannon is a bad deal for
 * the record and a good deal for the bank, and now the player can say that out loud.
 *
 * The bank is deliberately a plain number and not a ledger: what it buys is the deals (see
 * `contracts.ts`), the balance is shown in the menu, and a purchase is a subtraction that either
 * affords itself or does not. `localStorage`, best-effort, validated on read, so a blocked or
 * hand-edited store costs the player a currency rather than the game.
 */
const STORAGE_KEY = "watchme-run:bank";

export function readBank(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function write(value: number): number {
  const balance = Math.max(0, Math.floor(value));
  try {
    window.localStorage.setItem(STORAGE_KEY, String(balance));
  } catch {
    /* a blocked store costs the player the balance, not the run */
  }
  return balance;
}

/** Banks a finished run's tokens and answers the balance it left. */
export function bankTokens(amount: number): number {
  const paid = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;
  return write(readBank() + paid);
}

/** Spends a price if the bank holds it. `ok: false` means nothing was taken. */
export function spendTokens(cost: number): { ok: boolean; balance: number } {
  const balance = readBank();
  if (!Number.isFinite(cost) || cost <= 0) return { ok: true, balance };
  if (balance < cost) return { ok: false, balance };
  return { ok: true, balance: write(balance - cost) };
}
