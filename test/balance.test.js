// Protocol balance transfers: decoding, their signs in the rebuilt balance,
// the topic set read by the topic backfill, and the kind enum migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsFromLogs, ingestTopics, topicSetTopics, TOPIC_SET, BALANCE_EVENTS, TRANSFER_KINDS } from '../src/decode.js';
import { topicsFor } from '../src/abi.js';
import { BALANCE_MOVES, BALANCE_KINDS, protocolBalance } from '../src/revenue.js';
import { KINDS, FLAG, kindEnum, kindAlter, migrate } from '../src/schema.js';
import { logBuilder } from './helpers/logs.js';

test('each protocol balance transfer becomes its own row kind with its account, market and amount', () => {
  const b = logBuilder().at(500);
  b.tx()
    .add('TransferProtocolToAccount', { accountId: 42n, amountCNS: 7259740000n, balanceCNS: 9000000000n })
    .add('TransferAccountToProtocol', { accountId: 777n, amountCNS: 152663750000n, balanceCNS: 0n })
    .add('TransferPerpInsToProtocol', { perpId: 20n, amountCNS: 5000000n })
    .add('TransferPerpPosToProtocol', { perpId: 30n, amountCNS: 6000000n })
    .add('TransferProtocolToPerp', { perpId: 20n, amountCNS: 7000000n, toInsuranceFund: true })
    .add('TransferProtocolToPerp', { perpId: 20n, amountCNS: 8000000n, toInsuranceFund: false })
    .add('TransferProtocolToRecycleBal', { amountCNS: 9000000n })
    .add('RecycleFeeToProtocol', { perpId: 1n, orderId: 3n, recycleFeeCNS: 10000000n, recycleBalanceCNS: 11000000n })
    // The 1 June 2026 upgrade moved MON's position-balance residue in (block 78,474,467).
    .add('ResidueTransferred', { perpId: 10n, residueAmountCNS: 19850782420n, positionBalanceCNS: 4849964409n });
  const out = rowsFromLogs(b.logs, { unitsOf: () => null });
  const view = out.ev.map(r => ({ kind: r.kind, account: r.account, market: r.market, amount: r.amount, flags: r.flags }));
  assert.deepEqual(view, [
    { kind: 'payout', account: 42, market: 0, amount: 7259740000n, flags: 0 },
    { kind: 'sweep', account: 777, market: 0, amount: 152663750000n, flags: 0 },
    { kind: 'insurance_to_protocol', account: 0, market: 20, amount: 5000000n, flags: 0 },
    { kind: 'positions_to_protocol', account: 0, market: 30, amount: 6000000n, flags: 0 },
    { kind: 'protocol_to_market', account: 0, market: 20, amount: 7000000n, flags: FLAG.TO_INSURANCE },
    { kind: 'protocol_to_market', account: 0, market: 20, amount: 8000000n, flags: 0 },
    { kind: 'protocol_to_recycle', account: 0, market: 0, amount: 9000000n, flags: 0 },
    { kind: 'recycle_fee', account: 0, market: 1, amount: 10000000n, flags: 0 },
    { kind: 'residue_to_protocol', account: 0, market: 10, amount: 19850782420n, flags: 0 }
  ]);
  assert.equal(out.ev.at(-1).balance, 4849964409n, 'a residue transfer keeps the market\'s position balance after it');
  assert.equal(out.ev[0].balance, 9000000000n, 'a payout keeps the account balance after it');
  assert.deepEqual(TRANSFER_KINDS.slice().sort(), [...new Set(out.ev.map(r => r.kind))].sort(), 'every transfer kind is produced');
});

test('the rebuilt protocol balance adds revenue and inflows and subtracts outflows', () => {
  const moves = Object.fromEntries(BALANCE_KINDS.map(k => [k, { amount: 0n }]));
  Object.assign(moves, { protocol_deposit: { amount: 1000n }, protocol_withdrawal: { amount: 100n }, payout: { amount: 50n }, sweep: { amount: 7n }, insurance_to_protocol: { amount: 3n }, positions_to_protocol: { amount: 2n }, recycle_fee: { amount: 1n }, protocol_to_market: { amount: 20n }, protocol_to_recycle: { amount: 10n }, residue_to_protocol: { amount: 4n } });
  const revenue = { opening: 500n, reducing: 300n, liquidations: 200n };
  assert.equal(protocolBalance({ revenue, moves }), 500n + 300n + 200n + 1000n - 100n - 50n + 7n + 3n + 2n + 1n - 20n - 10n + 4n);
  assert.equal(BALANCE_MOVES.residue_to_protocol, 1n, 'a residue transfer adds to the protocol balance');
  assert.equal(protocolBalance({ revenue: { opening: 0n, reducing: 0n, liquidations: 0n }, moves: {} }), 0n, 'missing kinds count as zero');
  // Every stored transfer kind has a sign, and every sign belongs to a stored kind.
  for (const k of TRANSFER_KINDS) assert.ok(k in BALANCE_MOVES, k);
  for (const k of BALANCE_KINDS) assert.ok(k in KINDS, k);
});

test('the topic backfill reads the transfers and the rates that were not stored before, and the ingest reads them too', () => {
  const set = new Set(topicSetTopics);
  for (const t of topicsFor([...BALANCE_EVENTS, 'FeeParamsUpdated', 'ContractAdded', 'ContractAddedV2'])) assert.ok(set.has(t));
  assert.equal(set.size, TOPIC_SET.events.length);
  assert.ok(TOPIC_SET.events.includes('ResidueTransferred'));
  assert.ok(TOPIC_SET.events.includes('BuyToLiquidateParamsUpdated'));
  assert.equal(TOPIC_SET.name, 'protocol-v3', 'a new name: the set is read over the whole history again');
  for (const t of topicSetTopics) assert.ok(ingestTopics.includes(t), 'live commits count toward the topic coverage only if the ingest reads the topic too');
});

test('an index from before the transfers gains the new kinds in place, ev_account first, and only once', async () => {
  const old = kindEnum(Object.fromEntries(Object.entries(KINDS).filter(([, v]) => v < 60)));
  const run = async type => {
    const ran = [];
    await migrate({ database: 'perpl', exec: async sql => { ran.push(sql); }, query: async sql => (sql.includes('system.columns') ? [{ table: 'ev', type }, { table: 'ev_account', type }] : []) });
    return ran.filter(s => s.includes('MODIFY COLUMN kind'));
  };
  assert.deepEqual(await run(old), [kindAlter('ev_account'), kindAlter('ev')]);
  // An index that has the transfers but not the residue kind gains it the same way.
  const beforeResidue = kindEnum(Object.fromEntries(Object.entries(KINDS).filter(([k]) => k !== 'residue_to_protocol')));
  assert.deepEqual(await run(beforeResidue), [kindAlter('ev_account'), kindAlter('ev')]);
  assert.deepEqual(await run(kindEnum()), [], 'an up-to-date index is left alone');
  assert.ok(kindEnum().endsWith("'recycle_fee' = 66, 'residue_to_protocol' = 67)"), 'new values go at the end');
});
