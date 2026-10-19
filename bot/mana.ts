/**
 * Should a low contract Mana reading fail the bot run?
 *
 * `compound` burns spare KOIN into VHP, and burning spends the contract's own Mana (the contract caps the burn at the
 * Mana it has), so right after a compound the contract's Mana is near zero and then refills on its own. The health
 * check runs in the same tick, right after compounding, so without this it would email an alarm after every compound.
 *
 * Low Mana within COMPOUND_GRACE_BLOCKS (~6 hours) of the bot's last compound is expected: it is logged as a warning
 * and does not fail the run. Low Mana with no recent compound to explain it still fails the run (and emails you).
 */
export const CONTRACT_MANA_MIN = 10n * 100_000_000n;          // 10 KOIN of Mana
export const COMPOUND_GRACE_BLOCKS = 6 * 60 * 20;             // ~6 hours at ~3 s per block (7,200 blocks)

export type ManaVerdict = "ok" | "after-compound" | "low";

/**
 * @param mana         the contract's current Mana (satoshis)
 * @param seedKoin     the seed KOIN the contract holds (the check is off until there is a seed)
 * @param height       the current block height
 * @param lastCompound height of the bot's last successful compound (0 = never)
 */
export function contractManaVerdict(mana: bigint, seedKoin: bigint, height: number, lastCompound: number): ManaVerdict {
  if (seedKoin <= 0n || mana >= CONTRACT_MANA_MIN) return "ok";
  const since = height - lastCompound;
  if (lastCompound > 0 && since >= 0 && since <= COMPOUND_GRACE_BLOCKS) return "after-compound";
  return "low";
}
