import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dateIn, daysBetween } from '../lib/dates.ts';
import { letterDate, letterIsOpen, overlaps, separationLength, validateSeparation } from '../lib/separations.ts';
import { paragraphs } from '../lib/text.ts';

const trip = { startDate: '2028-02-28', meetDate: '2028-03-02' };

test('дата зависит от пояса получателя, а не сервера', () => {
  const now = new Date('2028-01-02T01:00:00Z');
  assert.equal(dateIn('America/New_York', now), '2028-01-01');
  assert.equal(dateIn('Asia/Tokyo', now), '2028-01-02');
});
test('календарная арифметика учитывает високосный день и обратное направление', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(daysBetween('2028-02-28', '2028-03-02'), 3);
});
test('начало и день встречи включены в нумерацию', () => {
  assert.equal(separationLength(trip), 4);
  assert.equal(letterDate(trip, 1), '2028-02-28');
  assert.equal(letterDate(trip, 4), '2028-03-02');
});
test('день встречи нельзя одновременно назначить началом другой разлуки', () => {
  assert.equal(overlaps(trip, { startDate: '2028-03-02', meetDate: '2028-03-04' }), true);
  assert.equal(overlaps(trip, { startDate: '2028-03-03', meetDate: '2028-03-04' }), false);
});
test('несуществующие даты, обратные периоды и неверные номера отклоняются', () => {
  assert.throws(() => validateSeparation({ startDate: '2027-02-29', meetDate: '2027-03-02' }));
  assert.throws(() => validateSeparation({ startDate: '2028-03-02', meetDate: '2028-02-28' }));
  for (const ordinal of [0, 5, 1.5]) assert.throws(() => letterDate(trip, ordinal));
});
test('сегодняшнее письмо открывается ровно в час получателя', () => {
  assert.equal(letterIsOpen(trip, 1, 'America/New_York', new Date('2028-02-28T12:59:00Z')), false);
  assert.equal(letterIsOpen(trip, 1, 'America/New_York', new Date('2028-02-28T13:00:00Z')), true);
});
test('вчерашнее открыто до утреннего часа, завтрашнее заперто', () => {
  const now = new Date('2028-02-29T10:00:00Z');
  assert.equal(letterIsOpen(trip, 1, 'America/New_York', now), true);
  assert.equal(letterIsOpen(trip, 2, 'America/New_York', now), false);
  assert.equal(letterIsOpen(trip, 3, 'America/New_York', now), false);
});
test('личный час открытия задаётся явно и проверяется', () => {
  const now = new Date('2028-02-28T10:00:00Z');
  assert.equal(letterIsOpen(trip, 1, 'UTC', now, 11), false);
  assert.equal(letterIsOpen(trip, 1, 'UTC', now, 10), true);
  assert.throws(() => letterIsOpen(trip, 1, 'UTC', now, 24));
});
test('абзацы сохраняют смысл при Windows/macOS/Unix переносах', () => {
  assert.deepEqual(paragraphs('  Первый\r\n\r\nВторой\r\rТретий\n\n '), ['Первый', 'Второй', 'Третий']);
  assert.deepEqual(paragraphs(' \r\n '), []);
});
