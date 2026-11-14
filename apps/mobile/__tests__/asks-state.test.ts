import { parseAskText, validAsk, followsAsk, orderAsks, exact } from '../src/auth/asks-state';
import { own, incoming, answered, skipped, withdrawn, context, uuid } from './asks-fixtures';
it('normalizes unicode paragraphs and rejects invalid text', () => {
    expect(parseAskText('  e\u0301\r\nnext ')).toBe('é\nnext');
    for (const value of [null, '', 'x'.repeat(2001), 'ba\td', '\ud800', 'x'.repeat(8001)])
        expect(parseAskText(value)).toBeNull();
});
it('strict question/response union, attribution and safe answered time', () => {
    for (const value of [own, incoming, answered, skipped, withdrawn, { ...answered, questionState: 'removed', question: undefined, version: 3 }]) {
        if (value.questionState === 'removed' && 'question' in value) {
            const { question: _, ...rest } = value;
            expect(validAsk(rest, context)).toBe(true);
        }
        else
            expect(validAsk(value, context)).toBe(true);
    }
    for (const value of [null, {}, { ...own, questionState: 'other' }, { ...own, responseState: 'other' }, { ...own, extra: 1 }, { ...own, id: 'bad' },
        { ...own, authorId: 'bad' }, { ...own, recipientId: 'bad' }, { ...own, recipientId: own.authorId }, { ...own, authorId: uuid(6), recipientId: uuid(7) },
        { ...own, coupleId: uuid(8) }, { ...own, membershipEpoch: 2 }, { ...own, createdAt: 'bad' }, { ...own, sequence: 0 }, { ...own, sequence: 101 }, { ...own, version: 0 }, { ...own, version: 2147483648 },
        { ...own, responseState: 'withdrawn' }, { ...withdrawn, responseState: 'waiting' }, { ...own, question: '' }, { ...own, question: ' trimmed ' }, { ...own, question: 3 },
        { ...answered, answer: '' }, { ...answered, answer: ' bad ' }, { ...answered, answer: 3 }, { ...answered, answeredAt: 'bad' }, { ...answered, answeredAt: '2020-01-01T00:00:00.000Z' },
        { ...skipped, answer: 'Forbidden' }, { ...withdrawn, question: 'Removed text' }])
        expect(validAsk(value, context)).toBe(false);
    expect(validAsk(own, { state: 'unmapped', sessionId: 'session' })).toBe(false);
    expect(exact({ a: 1, b: 2 }, 'b,a')).toBe(true);
});
it('state-machine fences prevent higher-version resurrection, edits and invalid terminal moves', () => {
    const removedAnswer = { ...answered, version: 3, responseState: 'answer_removed' as const };
    delete removedAnswer.answer;
    expect(validAsk(removedAnswer, context)).toBe(true);
    expect(followsAsk(incoming, answered)).toBe(true);
    expect(followsAsk(incoming, removedAnswer)).toBe(true);
    expect(followsAsk(answered, removedAnswer)).toBe(true);
    expect(followsAsk(own, withdrawn)).toBe(true);
    expect(followsAsk(own, { ...own })).toBe(true);
    for (const [before, after] of [[own, { ...own, id: uuid(99) }], [answered, { ...incoming, version: 3 }], [skipped, { ...answered, version: 3 }],
        [withdrawn, { ...own, version: 3 }], [answered, { ...answered, version: 3, answer: 'Edited' }], [answered, { ...removedAnswer, answeredAt: '2026-11-10T00:02:00.000Z' }],
        [own, { ...own, question: 'Changed' }], [own, { ...own, version: 2 }], [answered, { ...answered, version: 1 }], [own, { ...withdrawn, version: 8 }]])
        expect(followsAsk(before, after)).toBe(false);
    expect(orderAsks(own, answered)).toBeLessThan(0);
    expect(orderAsks({ ...own, sequence: 2 }, own)).toBeLessThan(0);
});
it('unknown snapshot must have the exact reachable version for its state', () => {
    const { question: _, ...removedAnswered } = { ...answered, questionState: 'removed' as const, version: 3 };
    const { answer: __, ...removedAnswer } = { ...answered, responseState: 'answer_removed' as const, version: 3 };
    const { question: ___, ...bothRemoved } = { ...removedAnswer, questionState: 'removed' as const, version: 4 };
    const removedSkipped = { ...withdrawn, responseState: 'skipped' as const, version: 3 };
    for (const item of [own, answered, skipped, withdrawn, removedAnswered, removedAnswer, bothRemoved, removedSkipped]) {
        expect(validAsk(item, context)).toBe(true);
        for (const version of [item.version - 1, item.version + 1, 99])
            expect(validAsk({ ...item, version }, context)).toBe(false);
    }
});
