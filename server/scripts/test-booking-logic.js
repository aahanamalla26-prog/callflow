// Offline tests for the pure booking logic. No Redis, MongoDB or network needed.
//   node scripts/test-booking-logic.js
import assert from 'node:assert/strict';
import {
  buildIdempotencyKey,
  candidateSlots,
  dayRange,
  describeSlot,
  isFinalFailure,
  missingBookingFields,
  parseDay,
  pickSlot,
} from '../src/queues/bookingLogic.js';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = at(2026, 10, 13, 11, 0); // Tue 13 Oct 2026, 11:00 local

test('parseDay accepts real days and rejects impossible or malformed ones', () => {
  assert.deepEqual(parseDay('2026-10-15'), { y: 2026, m: 10, d: 15 });
  for (const bad of ['2026-02-31', '2026-13-01', '15-10-2026', '', null, undefined, 20261015]) {
    assert.equal(parseDay(bad), null, String(bad));
  }
});

test('dayRange covers exactly one local day', () => {
  const { start, end } = dayRange('2026-10-15');
  assert.equal(describeSlot(start), '2026-10-15 00:00');
  assert.equal(describeSlot(end), '2026-10-16 00:00');
});

test('candidateSlots runs 10:00 to 16:30, then 09:00 and 09:30, 16 in total', () => {
  const slots = candidateSlots('2026-10-15').map(describeSlot);
  assert.equal(slots.length, 16);
  assert.equal(slots[0], '2026-10-15 10:00');
  assert.equal(slots[13], '2026-10-15 16:30');
  assert.deepEqual(slots.slice(14), ['2026-10-15 09:00', '2026-10-15 09:30']);
});

test('pickSlot takes 10:00 on an empty future day', () => {
  const { slot, reason } = pickSlot({ date: '2026-10-15', now: NOW });
  assert.equal(describeSlot(slot), '2026-10-15 10:00');
  assert.equal(reason, null);
});

test('pickSlot skips booked slots', () => {
  const booked = [at(2026, 10, 15, 10, 0), at(2026, 10, 15, 10, 30)];
  const { slot } = pickSlot({ date: '2026-10-15', booked, now: NOW });
  assert.equal(describeSlot(slot), '2026-10-15 11:00');
});

test('pickSlot wraps to the early morning when the rest of the day is full', () => {
  const booked = candidateSlots('2026-10-15').slice(0, 14);
  const { slot } = pickSlot({ date: '2026-10-15', booked, now: NOW });
  assert.equal(describeSlot(slot), '2026-10-15 09:00');
});

test('pickSlot reports no_slots when the day is full', () => {
  const booked = candidateSlots('2026-10-15');
  assert.deepEqual(pickSlot({ date: '2026-10-15', booked, now: NOW }), { slot: null, reason: 'no_slots' });
});

test('pickSlot only offers slots after now when the day is today', () => {
  const { slot } = pickSlot({ date: '2026-10-13', now: NOW }); // now is 11:00, so 11:00 itself is not allowed
  assert.equal(describeSlot(slot), '2026-10-13 11:30');
});

test('pickSlot reports past_date for yesterday and invalid_date for nonsense', () => {
  assert.equal(pickSlot({ date: '2026-10-12', now: NOW }).reason, 'past_date');
  assert.equal(pickSlot({ date: 'soon', now: NOW }).reason, 'invalid_date');
});

test('pickSlot reports no_slots when today is nearly over', () => {
  const lateNow = at(2026, 10, 13, 16, 45);
  assert.equal(pickSlot({ date: '2026-10-13', now: lateNow }).reason, 'no_slots');
});

test('missingBookingFields lists exactly what is absent', () => {
  assert.deepEqual(missingBookingFields({}), ['name', 'serviceType', 'preferredDate']);
  assert.deepEqual(missingBookingFields({ name: 'Asha', serviceType: 'oil change' }), ['preferredDate']);
  assert.deepEqual(missingBookingFields({ name: 'Asha', serviceType: 'oil change', preferredDate: '2026-02-31' }), ['preferredDate']);
  assert.deepEqual(missingBookingFields({ name: 'Asha', serviceType: 'oil change', preferredDate: '2026-10-15' }), []);
  assert.deepEqual(missingBookingFields(), ['name', 'serviceType', 'preferredDate']);
});

test('buildIdempotencyKey is stable, readable and safe as a BullMQ job id', () => {
  const input = { conversationId: '6acdbd1f77b87c6d817759ce', preferredDate: '2026-10-15', serviceType: 'Oil Change!!' };
  const key = buildIdempotencyKey(input);
  assert.equal(key, 'appt-6acdbd1f77b87c6d817759ce-2026-10-15-oil-change');
  assert.equal(buildIdempotencyKey(input), key);
  assert.ok(!key.includes(':'));
  assert.ok(!/^\d+$/.test(key));
  assert.notEqual(buildIdempotencyKey({ ...input, preferredDate: '2026-10-16' }), key);
});

test('buildIdempotencyKey copes with an odd service name', () => {
  const key = buildIdempotencyKey({ conversationId: 'c1', preferredDate: '2026-10-15', serviceType: '!!!' });
  assert.equal(key, 'appt-c1-2026-10-15-service');
});

test('isFinalFailure: last attempt, early attempt, and unrecoverable errors', () => {
  assert.equal(isFinalFailure({ err: new Error('x'), attemptsStarted: 3, attempts: 3 }), true);
  assert.equal(isFinalFailure({ err: new Error('x'), attemptsStarted: 1, attempts: 3 }), false);
  const unrecoverable = Object.assign(new Error('x'), { name: 'UnrecoverableError' });
  assert.equal(isFinalFailure({ err: unrecoverable, attemptsStarted: 1, attempts: 3 }), true);
  assert.equal(isFinalFailure({ err: new Error('x'), attemptsStarted: undefined, attempts: undefined }), true);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll booking logic tests passed');
process.exit(failures ? 1 : 0);
